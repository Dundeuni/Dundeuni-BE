import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessTokenGuard, AuthenticatedRequest } from './access-token.guard';

export const DEVELOPMENT_USER_ID = 'development-user';

/** Shared by analysis and future history routes. Fail closed outside explicit development. */
@Injectable()
export class RequestUserGuard extends AccessTokenGuard {
  constructor(private readonly environment: ConfigService) {
    super(environment);
  }

  override canActivate(context: ExecutionContext): boolean {
    if (
      process.env.NODE_ENV !== 'production' &&
      this.environment.get<string>('NODE_ENV') === 'development'
    ) {
      // Development always uses one identity, including requests carrying a token.
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.user = { id: DEVELOPMENT_USER_ID };
      return true;
    }
    return super.canActivate(context);
  }
}
