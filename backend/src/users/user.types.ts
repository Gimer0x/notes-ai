export type UserRow = {
  id: string;
  google_subject: string;
  email: string;
  display_name: string | null;
  plan_code: 'free' | 'paid';
  created_at: Date;
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  subscription_period_start: Date | null;
  subscription_period_end: Date | null;
};

export type GoogleIdentity = {
  subject: string;
  email: string;
  displayName: string | null;
};
