import { PNG } from 'pngjs';
import { AiPngBase64Localization } from './image-analysis-v1.dto';
export function validateLocalization(
  value: unknown,
): asserts value is AiPngBase64Localization | null {
  if (value === null) return;
  if (!value || typeof value !== 'object')
    throw new Error('Invalid localization');
  const map = value as AiPngBase64Localization;
  const dimension = (size: { width: number; height: number }) =>
    !!size &&
    Number.isInteger(size.width) &&
    Number.isInteger(size.height) &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= 2147483647 &&
    size.height <= 2147483647;
  if (
    map.format !== 'PNG_BASE64' ||
    map.kind !== 'MANIPULATION_HEATMAP' ||
    map.mimeType !== 'image/png' ||
    map.coordinateSpace !== 'ANALYSIS_IMAGE' ||
    !dimension(map.imageSize) ||
    !dimension(map.mapSize) ||
    Math.max(map.mapSize.width, map.mapSize.height) > 1024 ||
    Math.abs(
      map.mapSize.width * map.imageSize.height -
        map.mapSize.height * map.imageSize.width,
    ) >=
      (map.imageSize.width + map.imageSize.height) / 2 ||
    typeof map.data !== 'string' ||
    map.data.length === 0 ||
    map.data.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      map.data,
    )
  )
    throw new Error('Invalid localization metadata/base64');
  const bytes = Buffer.from(map.data, 'base64');
  if (
    bytes.length > 1048576 ||
    bytes.length < 33 ||
    bytes.toString('base64') !== map.data ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    ![0, 4].includes(bytes[25]) ||
    bytes.readUInt32BE(16) !== map.mapSize.width ||
    bytes.readUInt32BE(20) !== map.mapSize.height
  )
    throw new Error('Invalid PNG signature/dimensions');
  // IHDR 크기 제한을 먼저 확인하여 거대한 압축 이미지 할당을 방지한다.
  const decoded = PNG.sync.read(bytes, { checkCRC: true });
  if (
    decoded.width !== map.mapSize.width ||
    decoded.height !== map.mapSize.height
  )
    throw new Error('PNG size mismatch');
}
