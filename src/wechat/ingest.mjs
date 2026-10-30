/**
 * 入站媒体：把微信消息里的图片/文件落到租户工作区，并转成 agent 能用的形态。
 *
 * 一块行为，两个入口：
 *   - loadImages() 下载/解密图片 → 保留原图 → 压缩/转码 → base64 图片块
 *   - loadFiles()  下载/解密文件 → 落到 _inbox → 返回「路径 + 探测策略」说明
 *
 * 只依赖 cwd 和 log。下载与图像工具链保持**动态 import**：
 * 普通文本会话不应该在启动时加载图片处理模块。
 */

import { join } from 'node:path';

export class MediaIngest {
  /**
   * @param {object} opts
   * @param {string} opts.cwd - 租户工作区（_inbox / _inbox/originals 都在它下面）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ cwd, log = () => {} }) {
    this.cwd = cwd;
    this.log = log;
  }

  /**
   * 下载并解密消息里的图片，大图/不支持格式自动压缩或转码，
   * 再把原图存到 `_inbox/originals/` 供追溯，最后转成 SDK 的图片块。
   * 任一张失败只跳过该张，不影响其余内容。
   * @param {string} from
   * @param {object[]} rawImages - image_item 原始数组
   * @returns {Promise<{data:string, mimeType:string, bytes:number,
   *                    originalPath?:string, converted?:boolean}[]>}
   */
  async loadImages(from, rawImages) {
    if (!Array.isArray(rawImages) || rawImages.length === 0) return [];
    const { downloadImage } = await import('./media.mjs');
    const { normalizeImage, saveOriginalImage } = await import('./image-tools.mjs');
    const out = [];
    const originalDir = join(this.cwd, '_inbox', 'originals');

    for (const item of rawImages.slice(0, 20)) {
      const img = await downloadImage(item).catch(() => null);
      if (!img) {
        this.log('🖼 图片下载/解密失败，已退化为占位文本');
        continue;
      }

      const buffer = img.buffer ?? Buffer.from(img.data, 'base64');

      // 原图永远先落盘，转换失败也不影响追溯
      let originalPath;
      try {
        const saved = await saveOriginalImage(originalDir, buffer, { mimeType: img.mimeType });
        originalPath = saved.path;
        this.log(`🖼 原图已保留: ${saved.path} (${img.mimeType}, ${Math.round(saved.bytes / 1024)}KB)`);
      } catch (err) {
        this.log(`🖼 原图保存失败（不影响识别）: ${err.message}`);
      }

      let norm;
      try {
        norm = await normalizeImage(buffer, { mimeType: img.mimeType });
      } catch (err) {
        this.log(`🖼 图片格式不支持且转换失败，已跳过: ${err.message}`);
        continue;
      }

      if (norm.converted) {
        this.log(
          `🖼 图片已转换 ${norm.originalMimeType} → ${norm.mimeType}`
          + `（${Math.round(buffer.length / 1024)}KB → ${Math.round(norm.buffer.length / 1024)}KB，${norm.tool}）`,
        );
      } else if (norm.reason) {
        this.log(`🖼 图片压缩失败，按原图发送（${norm.reason}）`);
      } else {
        this.log(`🖼 图片已解密 (${norm.mimeType}, ${Math.round(norm.buffer.length / 1024)}KB)`);
      }

      out.push({
        data: norm.buffer.toString('base64'),
        mimeType: norm.mimeType,
        bytes: norm.buffer.length,
        originalPath,
        converted: norm.converted,
      });
    }
    return out;
  }

  /**
   * 下载消息里的文件到租户工作区，返回一段说明文本供 agent 使用。
   * 文件内容**不**进上下文，只给路径，避免大文件撑爆。
   * @param {object[]} rawFiles - file_item 原始数组
   * @returns {Promise<string>} 无文件时返回空串
   */
  async loadFiles(rawFiles) {
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) return '';
    const { downloadFile } = await import('./media.mjs');
    const { formatFileNote } = await import('../agent/file-digest.mjs');
    const inbox = join(this.cwd, '_inbox');
    const files = [];
    for (const item of rawFiles.slice(0, 10)) {
      const f = await downloadFile(item, { destDir: inbox }).catch(() => null);
      if (f) {
        this.log(`📎 文件已保存: ${f.path} (${Math.round(f.bytes / 1024)}KB)`);
        files.push({ ok: true, path: f.path, name: f.name, bytes: f.bytes });
      } else {
        this.log(`📎 文件下载失败: ${item.file_name ?? '(未命名)'}`);
        files.push({ ok: false, name: item.file_name ?? '(未命名)' });
      }
    }
    return formatFileNote(files);
  }
}
