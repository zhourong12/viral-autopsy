/** Browser-side file helpers: base64 for uploads, and screenshot preparation. */

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败。"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`无法读取图片：${file.name}`));
    };
    image.src = url;
  });
}

/** Longest edge sent to the model; larger images are scaled down anyway and only cost more. */
const maxEdge = 1568;
/** Taller than this ratio (a long scrolling screenshot) gets cut into overlapping pieces. */
const maxRatio = 2.2;

function toJpeg(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number): string {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持图片处理。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * Scale screenshots down and cut long ones into overlapping pieces so each piece stays legible.
 * Rows that appear in two pieces are merged on the server.
 */
export async function prepareScreenshots(
  files: File[],
): Promise<Array<{ mediaType: "image/jpeg"; data: string }>> {
  const pieces: Array<{ mediaType: "image/jpeg"; data: string }> = [];
  for (const file of files) {
    const image = await loadImage(file);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (height / width <= maxRatio) {
      pieces.push({ mediaType: "image/jpeg", data: toJpeg(image, 0, 0, width, height) });
      continue;
    }
    const pieceHeight = Math.round(width * 2);
    const step = Math.round(pieceHeight * 0.9);
    for (let top = 0; top < height; top += step) {
      const sliceHeight = Math.min(pieceHeight, height - top);
      if (sliceHeight < width * 0.3 && top > 0) break;
      pieces.push({ mediaType: "image/jpeg", data: toJpeg(image, 0, top, width, sliceHeight) });
    }
  }
  return pieces;
}
