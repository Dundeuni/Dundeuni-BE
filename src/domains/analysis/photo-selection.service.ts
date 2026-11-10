import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import sharp = require('sharp');
import { ApiError } from '../../common/http/api-error';
import { AnalysisService } from './analysis.service';
import {
  PHOTO_DETECTOR_VERSION,
  PhotoBox,
  PhotoRegionDetector,
} from './photo-region.detector';

type Candidate = {
  elementId: string;
  type: 'ORIGINAL' | 'PHOTO_REGION';
  bbox: PhotoBox;
};
type Upload = {
  owner: string;
  buffer: Buffer;
  originalBuffer: Buffer;
  originalMime: string;
  original: Candidate;
  width: number;
  height: number;
  expires: number;
  candidates: Candidate[];
  busy: boolean;
};
@Injectable()
export class PhotoSelectionService implements OnModuleDestroy {
  private readonly uploads = new Map<string, Upload>();
  private bytes = 0;
  private reserved = 0;
  private active = 0;
  private readonly pendingOwners = new Map<string, number>();
  private readonly timer = setInterval(() => this.sweep(), 30000);
  constructor(
    private readonly detector: PhotoRegionDetector,
    private readonly analysis: AnalysisService,
    private readonly config: ConfigService,
  ) {
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    for (const id of this.uploads.keys()) this.remove(id);
  }
  private remove(id: string) {
    const u = this.uploads.get(id);
    if (!u) return;
    this.bytes -= u.buffer.length + u.originalBuffer.length;
    u.originalBuffer.fill(0);
    u.buffer.fill(0);
    this.uploads.delete(id);
  }
  private sweep() {
    for (const [id, u] of this.uploads)
      if (!u.busy && u.expires <= Date.now()) this.remove(id);
  }
  private get(owner: string, id: string) {
    const u = this.uploads.get(id);
    if (!u || u.owner !== owner || u.expires <= Date.now())
      throw new ApiError(404, 'COMMON404', '업로드가 없거나 만료되었습니다.');
    return u;
  }
  private view(id: string, u: Upload) {
    return {
      uploadId: id,
      status: u.candidates.length ? 'AWAITING_SELECTION' : 'NO_CANDIDATES',
      image: {
        width: u.width,
        height: u.height,
        coordinateSpace: 'NORMALIZED_IMAGE',
      },
      detectorVersion: PHOTO_DETECTOR_VERSION,
      expiresAt: new Date(u.expires).toISOString(),
      original: u.original,
      elements: u.candidates,
    };
  }
  async extract(owner: string, file?: Express.Multer.File) {
    this.sweep();
    let image: Buffer | undefined,
      reserve = 0;
    let admitted = false;
    try {
      const max = Number(
        this.config.get('ANALYSIS_MAX_FILE_BYTES') ?? 10485760,
      );
      if (!Number.isSafeInteger(max) || max <= 0)
        throw new ApiError(
          500,
          'COMMON500',
          '업로드 제한 설정이 올바르지 않습니다.',
        );
      if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length)
        throw new ApiError(400, 'COMMON400', '이미지가 필요합니다.');
      if (file.buffer.length > Math.min(max, 10485760))
        throw new ApiError(
          413,
          'COMMON413',
          '이미지 크기 제한을 초과했습니다.',
        );
      const ext = extname(file.originalname).toLowerCase();
      const png =
        file.mimetype === 'image/png' &&
        ext === '.png' &&
        file.buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpg =
        file.mimetype === 'image/jpeg' &&
        ['.jpg', '.jpeg'].includes(ext) &&
        file.buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      if (!png && !jpg)
        throw new ApiError(415, 'COMMON415', 'JPEG/PNG 이미지만 지원합니다.');
      if (
        this.active >= 2 ||
        [...this.uploads.values()].filter((u) => u.owner === owner).length +
          (this.pendingOwners.get(owner) ?? 0) >=
          5
      )
        throw new ApiError(429, 'USAGE429', '대기 중인 업로드가 많습니다.');
      // Reserve worst-case temporary storage before asynchronous decoding.
      reserve = 64 * 1024 * 1024;
      if (this.bytes + this.reserved + reserve > 128 * 1024 * 1024)
        throw new ApiError(429, 'USAGE429', '임시 저장 공간이 부족합니다.');
      this.reserved += reserve;
      this.active++;
      admitted = true;
      this.pendingOwners.set(owner, (this.pendingOwners.get(owner) ?? 0) + 1);
      const source = sharp(file.buffer, {
        limitInputPixels: 16000000,
        failOn: 'warning',
      });
      const meta = await source.metadata();
      if (
        (meta.pages ?? 1) !== 1 ||
        !meta.width ||
        !meta.height ||
        meta.width < 32 ||
        meta.height < 32 ||
        meta.width > 8192 ||
        meta.height > 8192
      )
        throw new ApiError(
          400,
          'COMMON400',
          '이미지 크기 또는 프레임이 올바르지 않습니다.',
        );
      const normalized = await source
        .rotate()
        .toColourspace('srgb')
        .png()
        .toBuffer({ resolveWithObject: true });
      image = normalized.data;
      if (image.length + file.buffer.length > reserve)
        throw new ApiError(413, 'COMMON413', '정규화 이미지가 너무 큽니다.');
      const { width, height } = normalized.info;
      const boxes = await this.detector.detect(image, width, height);
      const id = randomUUID(),
        u: Upload = {
          owner,
          buffer: image,
          originalBuffer: Buffer.from(file.buffer),
          originalMime: file.mimetype,
          original: {
            elementId: randomUUID(),
            type: 'ORIGINAL',
            bbox: { left: 0, top: 0, width, height },
          },
          width,
          height,
          expires: Date.now() + 10 * 60000,
          candidates: boxes.map((bbox) => ({
            elementId: randomUUID(),
            type: 'PHOTO_REGION',
            bbox,
          })),
          busy: false,
        };
      this.uploads.set(id, u);
      this.bytes += image.length + u.originalBuffer.length;
      image = undefined;
      return {
        isSuccess: true,
        code: 'IMAGE_UPLOAD201',
        message: '사진 후보 추출이 완료되었습니다.',
        result: this.view(id, u),
      };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, 'COMMON400', '이미지를 처리할 수 없습니다.');
    } finally {
      if (admitted) {
        this.reserved -= reserve;
        this.active--;
        const pending = (this.pendingOwners.get(owner) ?? 1) - 1;
        if (pending) this.pendingOwners.set(owner, pending);
        else this.pendingOwners.delete(owner);
      }
      image?.fill(0);
      if (Buffer.isBuffer(file?.buffer)) file.buffer.fill(0);
    }
  }
  read(owner: string, id: string) {
    return {
      isSuccess: true,
      code: 'IMAGE_UPLOAD200',
      message: '사진 후보 조회에 성공했습니다.',
      result: this.view(id, this.get(owner, id)),
    };
  }
  cancel(owner: string, id: string) {
    const u = this.get(owner, id);
    if (u.busy) throw new ApiError(409, 'COMMON409', '분석이 진행 중입니다.');
    this.remove(id);
    return {
      isSuccess: true,
      code: 'IMAGE_UPLOAD200',
      message: '임시 이미지를 삭제했습니다.',
      result: null,
    };
  }
  async select(owner: string, id: string, elementId: string) {
    const u = this.get(owner, id);
    if (u.busy) throw new ApiError(409, 'COMMON409', '분석이 진행 중입니다.');
    const candidate =
      u.original.elementId === elementId
        ? u.original
        : u.candidates.find((c) => c.elementId === elementId);
    if (!candidate)
      throw new ApiError(400, 'COMMON400', '선택한 사진 후보가 없습니다.');
    u.busy = true;
    let crop: Buffer | undefined;
    try {
      crop =
        candidate.type === 'ORIGINAL'
          ? Buffer.from(u.originalBuffer)
          : await sharp(u.buffer).extract(candidate.bbox).png().toBuffer();
      const mime = candidate.type === 'ORIGINAL' ? u.originalMime : 'image/png';
      const result = await this.analysis.create(
        owner,
        {
          buffer: crop,
          size: crop.length,
          mimetype: mime,
          originalname:
            mime === 'image/jpeg' ? 'selected-photo.jpg' : 'selected-photo.png',
        } as Express.Multer.File,
        {
          uploadId: id,
          elementId,
          selectionType: candidate.type,
          bbox: candidate.bbox,
          imageWidth: u.width,
          imageHeight: u.height,
          coordinateSpace: 'NORMALIZED_IMAGE',
          preprocessingVersion: PHOTO_DETECTOR_VERSION,
        },
      );
      this.remove(id);
      return result;
    } finally {
      crop?.fill(0);
      u.busy = false;
      if (u.expires <= Date.now()) this.remove(id);
    }
  }
}
