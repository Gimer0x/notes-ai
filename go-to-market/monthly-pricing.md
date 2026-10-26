# Pith monthly pricing analysis

$9.99 a month is the right shelf price for a simple meeting notepad. It is the wrong price for a 100-hour allowance. Transcription is almost the whole AI bill. The summary and the chat box are cents.

The product today is seeded at **$7.99 a month** (or **$87.99 a year**) with **100 hours** of listening. This note is the pricing recommendation, not a description of the live plan.

## Recommendation

- Charge **$9.99 a month**.
- Include **20 hours** of listening, not 100. Twenty hours is about five hours of meetings a week.
- Leave the chat box unlimited. It does not move the price.
- Stay under Granola’s **$14**. That price pays for a larger product. Matching it does not make a 100-hour plan safe.

A user who records 100 dense hours costs about **$21.70** in AI, Stripe, and a small server share. At $9.99 that is an **$11.70** loss. At $14 it is still about an **$8** loss.

## Cost of one hour of audio

Pith transcribes with `gpt-4o-mini-transcribe` and writes the summary and chat answers with `gpt-4o-mini`. Silence is not sent. Overlapping speech is sent once, as the mix, so the bill follows speaking time, not two copies of the meeting.

| Meeting                       | Speech billed | Transcription | Summary | Hour total |
| ----------------------------- | ------------- | ------------- | ------- | ---------- |
| Sparse, long pauses           | 24 min        | $0.07         | $0.003  | $0.08      |
| Typical conversation          | 42 min        | $0.13         | $0.004  | $0.13      |
| People talking the whole hour | 60 min        | $0.18         | $0.006  | $0.19      |

Source: OpenAI pricing page, 26 Oct 2026. `gpt-4o-mini-transcribe` is listed at **$0.003 per minute** ($1.25 / $5.00 per 1M audio tokens). `gpt-4o-mini` text is **$0.15** in and **$0.60** out per 1M tokens. OpenAI marks `gpt-4o-mini-transcribe` deprecated on its model page; a replacement model can move the $0.003 figure. A retried slice is billed again.

A typical hour is about **$0.13**. The ceiling, if the whole hour is speech, is about **$0.18**.

## Chat

A normal question sends a few thousand tokens of notes and gets a short answer: about **$0.002 to $0.004**. The todo list does not call the model. A spoken question adds a few seconds of the same $0.003-per-minute transcriber. Four attached images can push one question toward **$0.01**. Eighty questions in a month are still well under **$1**.

## Where a typical $9.99 goes

One subscriber, 12 meeting hours, 40 questions:

| Piece                 | Amount |
| --------------------- | ------ |
| Audio and summary     | $1.56  |
| Chat                  | $0.12  |
| Stripe (2.9% + $0.30) | $0.59  |
| Server share          | $0.50  |
| Margin                | $7.22  |

The server share is a $0.50 allowance that shrinks as more people pay. Checkout is on the website, so there is no app-store cut. A yearly plan pays the Stripe fee once, so the monthly margin is a little higher if usage stays the same.

## Margin at $9.99

| Month                 | Meetings                      | AI     | Stripe + server | Margin  | Margin % |
| --------------------- | ----------------------------- | ------ | --------------- | ------- | -------- |
| Best, light use       | 4 h, sparse, 10 questions     | $0.32  | $1.09           | $8.58   | 86%      |
| Expected professional | 12 h, typical, 40 questions   | $1.68  | $1.09           | $7.22   | 72%      |
| Busy week after week  | 25 h, typical, heavier chat   | $4.05  | $1.09           | $4.85   | 49%      |
| Safe cap, worst audio | 20 h, dense, heavy chat ($2)  | $5.72  | $1.09           | $3.18   | 32%      |
| Stress                | 40 h, dense, heavy chat ($2)  | $9.44  | $1.09           | −$0.54  | loss     |
| Current paid cap      | 100 h, dense, heavy chat ($2) | $20.60 | $1.09           | −$11.70 | loss     |

Light is sparse speech. Typical is about 70% of the hour spoken. Dense means people talk the whole hour.

$9.99 stays profitable through a busy professional month and through a worst-case **20-hour** month. It breaks around **40 dense hours**. It does not survive the current **100-hour** cap.

## Price versus Granola’s $14

Raising the sticker from $7.99 to $14 does not fix a 100-hour plan. It mostly changes how much you keep on the customer this product is for: someone with a few meetings a week who does not want another system in the way.

Same AI and the same $0.50 server share in every row. Stripe is 2.9% + $0.30 on one monthly charge.

| Monthly price        | Stripe fee | Margin on 12 typical hours | Margin on 40 dense hours |
| -------------------- | ---------- | -------------------------- | ------------------------ |
| $7.99, current plan  | $0.53      | $5.28                      | −$2.48                   |
| $9.99, recommended   | $0.59      | $7.22                      | −$0.54                   |
| $12                  | $0.65      | $9.17                      | $1.41                    |
| $14, Granola’s price | $0.71      | $11.11                     | $3.35                    |

At 100 dense hours, even $14 still loses about $8.

## What to change

Keep **$9.99**. Cut the included listening from 100 hours to **20 hours**. Leave chat unlimited. Do not match Granola’s $14 unless the product grows into the things that price is paying for.
