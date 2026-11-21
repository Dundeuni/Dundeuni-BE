import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessTokenGuard, AuthenticatedRequest } from './access-token.guard';

/** Authentication bypass requires an explicit flag in development only. */
@Injectable()
export class RequestUserGuard extends AccessTokenGuard {
  constructor(private readonly environment: ConfigService) {
    super(environment);
  }
  override canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (
      !request.headers.authorization &&
      process.env.NODE_ENV !== 'production' &&
      this.environment.get<string>('NODE_ENV') === 'development' &&
      this.environment.get<string>('ANALYSIS_AUTH_BYPASS') === 'true'
    ) {
      request.user = { id: 'development-user' };
      return true;
    }
    return super.canActivate(context);
  }
}
