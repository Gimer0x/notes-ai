import { googlePictureUrl } from './google-oauth';

describe('googlePictureUrl', () => {
  it('keeps a Google profile photo', () => {
    expect(
      googlePictureUrl('https://lh3.googleusercontent.com/a/example=s96-c'),
    ).toBe('https://lh3.googleusercontent.com/a/example=s96-c');
  });

  it('rejects other hosts and non-https URLs', () => {
    expect(googlePictureUrl('https://example.com/a.png')).toBeNull();
    expect(googlePictureUrl('http://lh3.googleusercontent.com/a/example')).toBeNull();
    expect(googlePictureUrl('not a url')).toBeNull();
  });
});
