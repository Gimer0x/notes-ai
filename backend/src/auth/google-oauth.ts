export type GoogleProfile = {
  subject: string;
  email: string;
  displayName: string | null;
};

export async function exchangeGoogleCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleProfile> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokenJson = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !tokenJson.access_token) {
    throw new Error(
      tokenJson.error_description || tokenJson.error || 'google_token_failed',
    );
  }
  const userResponse = await fetch(
    'https://openidconnect.googleapis.com/v1/userinfo',
    { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
  );
  const profile = (await userResponse.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    error?: string;
  };
  if (!userResponse.ok || !profile.sub || !profile.email) {
    throw new Error(profile.error || 'google_profile_failed');
  }
  return {
    subject: profile.sub,
    email: profile.email,
    displayName: profile.name?.trim() || null,
  };
}
