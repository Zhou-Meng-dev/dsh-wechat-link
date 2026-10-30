#!/usr/bin/env python3
"""维护面试/练习题的进度与计分。

状态文件默认是工作区的 `_quiz/state.json`，`/new` 或服务重启都不会清掉。

用法：
    python3 _tools/quiz.py status [--json]
    python3 _tools/quiz.py pending              # 有待回答题目时退出码 0，否则 1
    python3 _tools/quiz.py ask --question "题目" [--answer "参考答案"] [--source "题库/文件"]
    python3 _tools/quiz.py record correct|wrong|skip [--note "说明"]
    python3 _tools/quiz.py reset [--keep-score]

约定：
    - `ask` 登记一道待回答的题，并把“已问”计数 +1
    - `record` 结算当前待回答的题：correct/wrong/skip，然后清空 pending
    - 同一时间只允许一道 pending；重复 ask 需要 --force
    - 退出码：0=成功，1=没有 pending，2=用法错误/状态冲突
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

DEFAULT_STATE = {
    "version": 1,
    "pending": None,
    "totals": {"asked": 0, "answered": 0, "correct": 0, "wrong": 0, "skipped": 0},
    "streak": {"current": 0, "best": 0},
    "history": [],
    "updatedAt": None,
}

HISTORY_LIMIT = 100


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def state_path() -> Path:
    raw = os.environ.get("QUIZ_STATE", "").strip()
    if raw:
        return Path(raw).expanduser()
    workspace = Path(__file__).resolve().parent.parent
    return workspace / "_quiz" / "state.json"


def load_state(path: Path) -> dict:
    if not path.is_file():
        return json.loads(json.dumps(DEFAULT_STATE))
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return json.loads(json.dumps(DEFAULT_STATE))

    state = json.loads(json.dumps(DEFAULT_STATE))
    if isinstance(data, dict):
        if isinstance(data.get("pending"), dict):
            state["pending"] = data["pending"]
        totals = data.get("totals")
        if isinstance(totals, dict):
            for key in state["totals"]:
                value = totals.get(key)
                if isinstance(value, int) and value >= 0:
                    state["totals"][key] = value
        streak = data.get("streak")
        if isinstance(streak, dict):
            for key in state["streak"]:
                value = streak.get(key)
                if isinstance(value, int) and value >= 0:
                    state["streak"][key] = value
        if isinstance(data.get("history"), list):
            state["history"] = [h for h in data["history"] if isinstance(h, dict)][-HISTORY_LIMIT:]
        if isinstance(data.get("updatedAt"), str):
            state["updatedAt"] = data["updatedAt"]
    return state


def save_state(path: Path, state: dict) -> None:
    state["updatedAt"] = now_iso()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def accuracy(totals: dict) -> str:
    answered = totals.get("answered", 0)
    if answered <= 0:
        return "-"
    return f"{totals.get('correct', 0) / answered * 100:.1f}%"


def print_status(state: dict) -> None:
    pending = state.get("pending")
    if pending:
        print(f"待回答: {pending.get('question', '')}")
        if pending.get("source"):
            print(f"来源: {pending['source']}")
        if pending.get("askedAt"):
            print(f"出题时间: {pending['askedAt']}")
    else:
        print("待回答: 无")

    t = state["totals"]
    s = state["streak"]
    print(
        "计分: "
        f"已问 {t['asked']} / 已答 {t['answered']} / "
        f"正确 {t['correct']} / 错误 {t['wrong']} / 跳过 {t['skipped']} / "
        f"正确率 {accuracy(t)}"
    )
    print(f"连续正确: {s['current']}（最高 {s['best']}）")


def cmd_status(args) -> int:
    state = load_state(state_path())
    if args.json:
        print(json.dumps(state, ensure_ascii=False, indent=2))
    else:
        print_status(state)
    return 0


def cmd_pending(args) -> int:
    state = load_state(state_path())
    pending = state.get("pending")
    if not pending:
        print("NONE")
        return 1
    print(f"题目: {pending.get('question', '')}")
    if pending.get("source"):
        print(f"来源: {pending['source']}")
    return 0


def cmd_ask(args) -> int:
    question = str(args.question or "").strip()
    if not question:
        print("--question 不能为空", file=sys.stderr)
        return 2

    path = state_path()
    state = load_state(path)
    if state.get("pending") and not args.force:
        print("已有待回答的题目；先 record，或加 --force 覆盖", file=sys.stderr)
        return 2

    state["pending"] = {
        "question": question,
        "answer": str(args.answer or "").strip(),
        "source": str(args.source or "").strip(),
        "askedAt": now_iso(),
    }
    state["totals"]["asked"] += 1
    save_state(path, state)
    print(f"已登记第 {state['totals']['asked']} 题")
    return 0


def cmd_record(args) -> int:
    path = state_path()
    state = load_state(path)
    pending = state.get("pending")
    if not pending:
        print("当前没有待回答的题目", file=sys.stderr)
        return 2

    result = args.result
    state["totals"][result if result != "skip" else "skipped"] += 1
    if result in ("correct", "wrong"):
        state["totals"]["answered"] += 1

    if result == "correct":
        state["streak"]["current"] += 1
        state["streak"]["best"] = max(state["streak"]["best"], state["streak"]["current"])
    else:
        state["streak"]["current"] = 0

    entry = {
        "at": now_iso(),
        "result": result,
        "question": pending.get("question", ""),
        "source": pending.get("source", ""),
        "note": str(args.note or "").strip(),
    }
    state["history"] = (state["history"] + [entry])[-HISTORY_LIMIT:]
    state["pending"] = None
    save_state(path, state)

    print_status(state)
    return 0


def cmd_reset(args) -> int:
    path = state_path()
    state = load_state(path)
    state["pending"] = None
    if not args.keep_score:
        state["totals"] = json.loads(json.dumps(DEFAULT_STATE["totals"]))
        state["streak"] = json.loads(json.dumps(DEFAULT_STATE["streak"]))
        state["history"] = []
    save_state(path, state)
    print("已清空 pending" + ("" if args.keep_score else " 和计分"))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quiz.py", description="面试题进度与计分")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="查看进度与分数")
    status.add_argument("--json", action="store_true", help="输出 JSON")
    status.set_defaults(func=cmd_status)

    pending = sub.add_parser("pending", help="检查是否有待回答的题")
    pending.set_defaults(func=cmd_pending)

    ask = sub.add_parser("ask", help="登记一道待回答的题")
    ask.add_argument("--question", required=True)
    ask.add_argument("--answer", default="")
    ask.add_argument("--source", default="")
    ask.add_argument("--force", action="store_true", help="覆盖已有 pending")
    ask.set_defaults(func=cmd_ask)

    record = sub.add_parser("record", help="结算当前题目")
    record.add_argument("result", choices=["correct", "wrong", "skip"])
    record.add_argument("--note", default="")
    record.set_defaults(func=cmd_record)

    reset = sub.add_parser("reset", help="清空 pending（可选保留计分）")
    reset.add_argument("--keep-score", action="store_true")
    reset.set_defaults(func=cmd_reset)

    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv[1:])
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
