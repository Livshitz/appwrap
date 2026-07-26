/** Downscale a UIImage to `maxSize` (longest edge) and encode as a JPEG data URL. */
export function uiImageToDataUrl(img: UIImage, maxSize: number): string {
  const w = img.size.width;
  const h = img.size.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);
  UIGraphicsBeginImageContextWithOptions({ width: tw, height: th } as CGSize, false, 1);
  img.drawInRect({ origin: { x: 0, y: 0 }, size: { width: tw, height: th } } as CGRect);
  const scaled = UIGraphicsGetImageFromCurrentImageContext() ?? img;
  UIGraphicsEndImageContext();
  const data = UIImageJPEGRepresentation(scaled, 0.85);
  const b64 = data ? data.base64EncodedStringWithOptions(0 as unknown as NSDataBase64EncodingOptions) : '';
  return `data:image/jpeg;base64,${b64}`;
}
