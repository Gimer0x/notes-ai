import { signUserToken, verifyUserToken } from './jwt';

const SECRET = 'unit-test-secret';

describe('jwt', () => {
  it('round-trips a user id', () => {
    const token = signUserToken('user-1', SECRET);
    expect(verifyUserToken(token, SECRET)).toBe('user-1');
  });

  it('returns null for a bad token', () => {
    expect(verifyUserToken('not-a-jwt', SECRET)).toBeNull();
  });
});
