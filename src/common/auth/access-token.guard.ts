import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { ApiError } from '../http/api-error';

export type AuthenticatedRequest = Request & { user: { id: string } };

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.headers.authorization)
      throw new ApiError(401, 'AUTH401', 'Access Token이 필요합니다.');
    const secret = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!secret || secret === 'change-me-to-a-long-random-value') {
      throw new ApiError(500, 'COMMON500', '인증 설정이 준비되지 않았습니다.');
    }
    try {
      const match =
        /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
          request.headers.authorization ?? '',
        );
      if (!match) throw new Error();
      const [header, payload, signature] = match[1].split('.');
      const metadata: unknown = JSON.parse(
        Buffer.from(header, 'base64url').toString(),
      );
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        !('alg' in metadata) ||
        metadata.alg !== 'HS256'
      )
        throw new Error();
      const expected = createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest();
      const actual = Buffer.from(signature, 'base64url');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error();
      const claims: unknown = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      );
      if (
        !claims ||
        typeof claims !== 'object' ||
        !('sub' in claims) ||
        typeof claims.sub !== 'string' ||
        !claims.sub.trim() ||
        !('exp' in claims) ||
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= Date.now() / 1000 ||
        ('nbf' in claims &&
          (typeof claims.nbf !== 'number' || claims.nbf > Date.now() / 1000))
      )
        throw new Error();
      request.user = { id: claims.sub };
      return true;
    } catch {
      throw new ApiError(401, 'AUTH401', '유효한 Access Token이 필요합니다.');
    }
  }
}
