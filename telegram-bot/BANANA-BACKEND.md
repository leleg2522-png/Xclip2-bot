# Banana image packages — SnapGen AI

Banana Pro, Banana 2 and Banana Lite use SnapGen again for text-to-image and
image-to-image. Per the existing product rule, Pro and Lite follow Banana 2's
backend (`nano-banana-2`); public names and individual prices stay separate.
Banana 2.1 remains on its existing independent route.

The bot uses its existing `SNAPGEN_API_KEY` environment variable. Renderful's
`/addkey` pool is not used for these image packages. No key or balance is
created by switching the route.

The existing adapter submits multipart data to `/generate_image` with `4K`,
`jpeg`, and the requested ratio. Up to two reference photos are downloaded by
the bot and sent as file bytes, never as Telegram-token URLs. Pending results
poll `/history/{uuid}`; immediate completed responses do not need polling.
There is one submit only: missing IDs, timeouts, rejected requests or polling
failures never replay the job or switch to another paid provider.

Delivery still verifies actual 4K dimensions and sends full-resolution documents
or our own temporary download link rather than compressed Telegram photos.
Failed generation, invalid resolution, missing key or failed delivery refunds
the full package charge.

`test:banana` checks active SnapGen routing, multipart contracts, both input
modes, immediate/polled results, no paid replay, individual prices/refunds, real
image delivery, and Banana 2.1 isolation. Legacy Renderful helper contracts are
retained as offline checks, not the active provider.

This code change does not deploy Railway, start local Telegram polling, or
perform paid live generation.
