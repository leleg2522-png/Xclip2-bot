---
name: OneOver submit timeouts
description: Production timeout behavior for Seedance 2.5 submission from Railway.
---

This contract is legacy-only. New public Seedance 2.5 orders no longer submit to
OneOver, but the rules remain relevant while old jobs or fallback code still exist.

Treat a submit request that ends in a transport timeout as **ambiguous**: the upstream may have received the request even if it did not return a prediction reference.

**Why:** A Railway production job exceeded the former 120-second client timeout after image conversion. The successful browser capture contains `Origin`, `Referer`, browser `User-Agent`, and related context headers that a bare server request omitted; the edge can hold such a request until it times out. Resubmitting automatically could create and bill for duplicate videos.

**How to apply:** Mirror the non-secret browser context headers on submit and poll, keep a longer dedicated submit timeout than polling, show waiting progress while it is in flight, and refund on an unresolved submit timeout rather than retrying or failing over to another account.

For the video function routes, successful browser polling and a safe balance check prove that the static `apikey` is sufficient; do not send short-lived user bearer tokens or cookies to these routes.

**Why:** The stored user bearer token expired in roughly one hour. The endpoint continued to return the same account balance when called with `apikey` alone, and HAR polling likewise had no cookie or `Authorization` header.

**How to apply:** Keep provider-account identity only for pool bookkeeping; authenticate video submit/poll requests with the pool account's stable `apikey` plus browser-context headers.