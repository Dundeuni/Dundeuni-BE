import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string) {
    super({ isSuccess: false, code, message, result: null }, status);
  }
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const codes: Record<number, string> = {
      400: 'COMMON400',
      401: 'AUTH401',
      409: 'COMMON409',
      413: 'COMMON413',
      415: 'COMMON415',
      429: 'USAGE429',
      503: 'ANALYSIS503',
    };
    let message =
      status === 500
        ? '서버 내부 오류가 발생했습니다.'
        : '요청을 처리할 수 없습니다.';
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'object' && 'message' in response) {
        const details: unknown = response.message;
        if (typeof details === 'string') message = details;
        else if (
          Array.isArray(details) &&
          details.every((item) => typeof item === 'string')
        ) {
          message = details.join(' ');
        }
      }
    }
    const body =
      error instanceof ApiError
        ? error.getResponse()
        : {
            isSuccess: false,
            code: codes[status] ?? 'COMMON500',
            message,
            result: null,
          };
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }
}
