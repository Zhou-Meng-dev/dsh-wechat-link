#!/usr/bin/env python3
"""等待桥接处理 _tasks/pending 里的请求，并打印最终结果。

用法：
    python3 _tools/taskctl.py wait rm-quiz.json [rm-2.json ...]

桥接处理完会原子写入 `_tasks/results/<同名>.json`，格式：
    {"ok": true, "text": "✅ 已取消定时任务「每日一题」", ...}

本脚本轮询该文件，打印 text，然后删除结果文件。
结果文件一出现就立即返回；超时时间只是桥接异常时的保护上限。
退出码：0=全部成功，1=有失败，2=用法错误/超时。
"""

import json
import os
import sys
import time
from pathlib import Path


def usage(msg: str) -> int:
    print(msg, file=sys.stderr)
    return 2


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] != "wait":
        return usage("用法: python3 _tools/taskctl.py wait <请求文件名> [...]")

    names = [os.path.basename(a) for a in argv[2:] if a.strip()]
    if not names:
        return usage("没有要等待的请求文件")

    workspace = Path(__file__).resolve().parent.parent
    results = workspace / "_tasks" / "results"
    # 10 秒只是桥接异常时的上限；正常桥接约 0.5 秒就会写入结果并立即返回
    timeout = float(os.environ.get("TASKCTL_TIMEOUT", "10"))
    deadline = time.monotonic() + timeout
    any_failed = False

    for name in names:
        if not name.endswith(".json"):
            name += ".json"
        result = results / name

        while time.monotonic() < deadline:
            if result.is_file():
                try:
                    data = json.loads(result.read_text("utf-8"))
                except (OSError, ValueError):
                    # 理论上桥接是原子 rename，不会读到半写；保险起见再等
                    time.sleep(0.05)
                    continue

                text = data.get("text") or (
                    "✅ 定时任务请求已生效" if data.get("ok") else "⚠️ 定时任务请求未生效"
                )
                print(text)
                if not data.get("ok"):
                    any_failed = True
                try:
                    result.unlink()
                except OSError:
                    pass
                break
            time.sleep(0.05)
        else:
            print(f"⚠️ 等待任务结果超时: {name}", file=sys.stderr)
            return 2

    return 1 if any_failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
