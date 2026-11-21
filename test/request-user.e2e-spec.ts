import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { RequestUserGuard } from '../src/common/auth/request-user.guard';

describe('analysis authentication environment policy', () => {
  it.each([
    ['production', 'true', false],
    ['test', 'true', false],
    ['development', 'false', false],
    ['development', 'true', true],
  ])(
    'environment %s bypass=%s permits local identity: %s',
    (env, flag, allowed) => {
      const request = { headers: {} } as any;
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as ExecutionContext;
      const guard = new RequestUserGuard(
        new ConfigService({ NODE_ENV: env, ANALYSIS_AUTH_BYPASS: flag }),
      );
      if (allowed) {
        expect(guard.canActivate(context)).toBe(true);
        expect(request.user.id).toBe('development-user');
      } else expect(() => guard.canActivate(context)).toThrow();
    },
  );
});
