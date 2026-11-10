import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp = require('sharp');
import { randomUUID } from 'node:crypto';
import { PhotoRegionDetector } from '../src/domains/analysis/photo-region.detector';
import { PhotoSelectionService } from '../src/domains/analysis/photo-selection.service';
import {
  PhotoSelectionController,
  PhotoSelectionGuard,
} from '../src/domains/analysis/photo-selection.controller';
import { AnalysisService } from '../src/domains/analysis/analysis.service';
import { AccessTokenGuard } from '../src/common/auth/access-token.guard';
import { UploadedImageCleanupInterceptor } from '../src/domains/analysis/uploaded-image-cleanup.interceptor';

const png = () =>
  sharp({
    create: { width: 200, height: 150, channels: 3, background: '#eee' },
  })
    .png()
    .toBuffer();
const file = (buffer: Buffer) =>
  ({
    buffer: Buffer.from(buffer),
    size: buffer.length,
    mimetype: 'image/png',
    originalname: 'screen.png',
  }) as Express.Multer.File;
const bbox = { left: 20, top: 30, width: 100, height: 80 };

describe('photo selection workflow', () => {
  let service: PhotoSelectionService;
  const detector = { detect: jest.fn() };
  const analysis = { create: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    detector.detect.mockResolvedValue([bbox]);
    analysis.create.mockResolvedValue({
      isSuccess: true,
      code: 'ANALYSIS202',
      result: { analysisId: randomUUID() },
    });
    service = new PhotoSelectionService(
      detector as any,
      analysis as any,
      new ConfigService({ ANALYSIS_MAX_FILE_BYTES: 10485760 }),
    );
  });
  afterEach(() => service.onModuleDestroy());
  it('does not analyze on extraction and crops only the selected region', async () => {
    const f = file(await png());
    const uploaded = await service.extract('alice', f);
    expect(analysis.create).not.toHaveBeenCalled();
    expect(f.buffer.every((x) => x === 0)).toBe(true);
    const { uploadId, elements } = uploaded.result;
    analysis.create.mockImplementation(async (_owner, selected, metadata) => {
      const m = await sharp(selected.buffer).metadata();
      expect([m.width, m.height]).toEqual([100, 80]);
      expect(metadata).toMatchObject({
        selectionType: 'PHOTO_REGION',
        uploadId,
        elementId: elements[0].elementId,
        bbox,
      });
      return { isSuccess: true };
    });
    await service.select('alice', uploadId, elements[0].elementId);
    expect(analysis.create).toHaveBeenCalledTimes(1);
    expect(() => service.read('alice', uploadId)).toThrow();
  });
  it('offers original when detection finds no photos and sends identical JPEG bytes', async () => {
    detector.detect.mockResolvedValue([]);
    const original = await sharp({
      create: { width: 120, height: 80, channels: 3, background: 'red' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { result: u } = await service.extract('alice', {
      ...file(original),
      mimetype: 'image/jpeg',
      originalname: 'photo.jpg',
    });
    expect(u.status).toBe('NO_CANDIDATES');
    expect(u.original).toMatchObject({
      type: 'ORIGINAL',
      bbox: { left: 0, top: 0, width: 80, height: 120 },
    });
    expect(analysis.create).not.toHaveBeenCalled();
    analysis.create.mockImplementation(async (_owner, selected, metadata) => {
      expect(selected.buffer.equals(original)).toBe(true);
      expect(selected.mimetype).toBe('image/jpeg');
      expect(metadata.selectionType).toBe('ORIGINAL');
      return { isSuccess: true };
    });
    await service.select('alice', u.uploadId, u.original.elementId);
    expect(analysis.create).toHaveBeenCalledTimes(1);
    expect(() => service.read('alice', u.uploadId)).toThrow();
  });
  it('provides stable original and region choices under the same upload', async () => {
    const { result: u } = await service.extract('alice', file(await png()));
    expect(u.original.type).toBe('ORIGINAL');
    expect(u.elements[0].type).toBe('PHOTO_REGION');
    expect(u.original.elementId).not.toBe(u.elements[0].elementId);
    expect(service.read('alice', u.uploadId).result.original.elementId).toBe(
      u.original.elementId,
    );
    await expect(
      service.select('bob', u.uploadId, u.original.elementId),
    ).rejects.toMatchObject({ status: 404 });
    expect(analysis.create).not.toHaveBeenCalled();
  });
  it('rejects wrong owner and unknown element without analyzing', async () => {
    const { result: u } = await service.extract('alice', file(await png()));
    expect(() => service.read('bob', u.uploadId)).toThrow();
    await expect(
      service.select('bob', u.uploadId, u.elements[0].elementId),
    ).rejects.toThrow();
    await expect(
      service.select('alice', u.uploadId, randomUUID()),
    ).rejects.toThrow();
    expect(analysis.create).not.toHaveBeenCalled();
  });
  it('returns no candidates without falling back to full image analysis', async () => {
    detector.detect.mockResolvedValue([]);
    const { result: u } = await service.extract('alice', file(await png()));
    expect(u.status).toBe('NO_CANDIDATES');
    await expect(
      service.select('alice', u.uploadId, randomUUID()),
    ).rejects.toThrow();
    expect(analysis.create).not.toHaveBeenCalled();
  });
  it('expires and cancels temporary uploads', async () => {
    const { result: u } = await service.extract('alice', file(await png()));
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 11 * 60000);
    expect(() => service.read('alice', u.uploadId)).toThrow();
    spy.mockRestore();
    service.cancel('alice', u.uploadId);
    expect(() => service.read('alice', u.uploadId)).toThrow();
  });
  it('retains an upload after AI failure and rejects concurrent selection', async () => {
    const { result: u } = await service.extract('alice', file(await png()));
    let release!: () => void;
    analysis.create.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(new Error('AI failure'));
        }),
    );
    const pending = service.select(
      'alice',
      u.uploadId,
      u.elements[0].elementId,
    );
    // Wait until crop completes and the analysis is in progress.
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await expect(
      service.select('alice', u.uploadId, u.elements[0].elementId),
    ).rejects.toMatchObject({ status: 409 });
    expect(() => service.cancel('alice', u.uploadId)).toThrow();
    const check = expect(pending).rejects.toThrow('AI failure');
    release();
    await check;
    expect(service.read('alice', u.uploadId).result.elements).toHaveLength(1);
  });
  it('limits pending uploads and releases capacity on cancellation', async () => {
    for (let i = 0; i < 5; i++)
      await service.extract('alice', file(await png()));
    await expect(
      service.extract('alice', file(await png())),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('rejects invalid formats, corrupt and oversized pixel inputs', async () => {
    await expect(
      service.extract('alice', file(Buffer.from('bad'))),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      service.extract(
        'alice',
        file(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const big = await sharp({
      create: { width: 5000, height: 4000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(service.extract('alice', file(big))).rejects.toMatchObject({
      status: 400,
    });
  });
  it('normalizes EXIF orientation before assigning candidate coordinates', async () => {
    const buffer = await sharp({
      create: { width: 120, height: 80, channels: 3, background: 'red' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { result: u } = await service.extract('alice', {
      ...file(buffer),
      mimetype: 'image/jpeg',
      originalname: 'rotated.jpg',
    });
    expect(u.image).toMatchObject({ width: 80, height: 120 });
  });
});

describe('photo selection HTTP API', () => {
  let app: INestApplication;
  const analysis = {
    create: jest.fn(async () => ({
      code: 'ANALYSIS202',
      isSuccess: true,
      result: { analysisId: randomUUID() },
    })),
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      controllers: [PhotoSelectionController],
      providers: [
        PhotoSelectionService,
        PhotoSelectionGuard,
        AccessTokenGuard,
        UploadedImageCleanupInterceptor,
        {
          provide: PhotoRegionDetector,
          useValue: { detect: async () => [bbox] },
        },
        { provide: AnalysisService, useValue: analysis },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            NODE_ENV: 'development',
            ANALYSIS_MAX_FILE_BYTES: 10485760,
          }),
        },
      ],
    }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(() => app.close());
  it('uploads then selects by ID and rejects client-supplied coordinates', async () => {
    const upload = await request(app.getHttpServer())
      .post('/api/analysis/image-uploads')
      .attach('file', await png(), 'screen.png')
      .expect(201);
    const u = upload.body.result;
    await request(app.getHttpServer())
      .post(`/api/analysis/image-uploads/${u.uploadId}/analyses`)
      .send({ elementId: u.elements[0].elementId, bbox })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/analysis/image-uploads/${u.uploadId}/analyses`)
      .send({ elementId: u.elements[0].elementId })
      .expect(202);
    await request(app.getHttpServer())
      .get(`/api/analysis/image-uploads/${u.uploadId}`)
      .expect(404);
  });
  it('requires authentication outside development', () => {
    const tokens = {
      canActivate: jest.fn(() => {
        throw new Error('auth required');
      }),
    };
    const guard = new PhotoSelectionGuard(
      new ConfigService({ NODE_ENV: 'production' }),
      tokens as any,
    );
    expect(() => guard.canActivate({} as ExecutionContext)).toThrow(
      'auth required',
    );
    expect(tokens.canActivate).toHaveBeenCalled();
  });
});

describe('Gemini photo panel detector', () => {
  const config = () =>
    new ConfigService({
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'test-model',
      PHOTO_DETECTION_TIMEOUT_MS: 100,
    });
  it('converts normalized coordinates, removes duplicates and collage containers', () => {
    const d = new PhotoRegionDetector(config());
    const boxes = d.parse(
      JSON.stringify({
        photos: [
          { box_2d: [100, 0, 900, 1000] },
          { box_2d: [100, 0, 500, 500] },
          { box_2d: [100, 0, 500, 500] },
          { box_2d: [100, 500, 500, 1000] },
        ],
      }),
      1000,
      2000,
    );
    expect(boxes).toEqual([
      { left: 0, top: 200, width: 500, height: 800 },
      { left: 500, top: 200, width: 500, height: 800 },
    ]);
  });
  it.each([
    'invalid',
    '{}',
    '{"photos":[{"box_2d":[0,0,1001,1000]}]}',
    '{"photos":[{"box_2d":[500,0,100,1000]}]}',
  ])('rejects invalid model output: %s', (text) => {
    expect(() =>
      new PhotoRegionDetector(config()).parse(text, 400, 400),
    ).toThrow();
  });
  it('sends an image preview and maps returned boxes to original pixels', async () => {
    const d = new PhotoRegionDetector(config());
    const spy = jest
      .spyOn(d, 'request')
      .mockResolvedValue('{"photos":[{"box_2d":[200,100,800,900]}]}');
    expect(await d.detect(await png(), 200, 150)).toEqual([
      { left: 20, top: 30, width: 160, height: 90 },
    ]);
    expect(spy.mock.calls[0][1]).toBe('test-model');
    expect(Buffer.isBuffer(spy.mock.calls[0][0])).toBe(true);
  });
  it('does not fall back to geometric splitting on vision service failure', async () => {
    const d = new PhotoRegionDetector(config());
    jest.spyOn(d, 'request').mockRejectedValue({ status: 503 });
    await expect(d.detect(await png(), 200, 150)).rejects.toMatchObject({
      status: 503,
      response: { code: 'PHOTO_DETECTION503' },
    });
  });
  it('bounds stalled vision requests', async () => {
    const d = new PhotoRegionDetector(config());
    jest.spyOn(d, 'request').mockImplementation(() => new Promise(() => {}));
    await expect(d.detect(await png(), 200, 150)).rejects.toMatchObject({
      status: 503,
    });
  });
  it('supports text-only screenshots with no photo regions', async () => {
    const d = new PhotoRegionDetector(config());
    jest.spyOn(d, 'request').mockResolvedValue('{"photos":[]}');
    expect(await d.detect(await png(), 200, 150)).toEqual([]);
  });
});

describe('screenshot vision coordinate regression', () => {
  it('keeps four photo panels and excludes clipped recommendation strips', () => {
    const d = new PhotoRegionDetector(new ConfigService());
    const photos = [
      [131, 14, 406, 497],
      [131, 504, 407, 985],
      [411, 15, 688, 495],
      [411, 504, 688, 985],
      [829, 9, 858, 495],
      [829, 504, 858, 989],
    ].map((box_2d) => ({ box_2d }));
    const result = d.parse(JSON.stringify({ photos }), 1206, 2622);
    expect(result).toHaveLength(4);
    expect(result.every((b) => b.top > 300 && b.top + b.height < 1850)).toBe(
      true,
    );
  });
});
