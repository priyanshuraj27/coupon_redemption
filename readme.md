# Coupon Redemption Service

A Node.js + Express + MongoDB API for creating coupons, redeeming them against orders, and cancelling orders. It stays correct when many requests arrive at once:

- A coupon is never redeemed more than `max_redemptions` times, even during a flash-sale burst.
- A **STANDARD** coupon can be used once per customer. A **STACKABLE** coupon can be used many times per customer, but the global cap still applies.
- Expired coupons are rejected.
- Cancelling an order gives its coupon slot back exactly once, even if the cancel endpoint is called more than once.
- Retried `POST /redeem` calls with the same `Idempotency-Key` never redeem twice.

Each redemption and cancellation runs as one MongoDB multi-document transaction (snapshot reads, majority + journaled writes). That is why **MongoDB has to run as a replica set**.

---

## Requirements

- **Node.js** 18 or newer (tested on 22). The project uses ES modules.
- **MongoDB** 6+ running as a **replica set**. A single-node replica set is fine for local development.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start MongoDB as a replica set

Transactions don't work on a standalone `mongod`, and the server refuses to start against one.

**Option A: local mongod**

```bash
mongod --replSet rs0 --dbpath <your-data-dir>
```

Then, once only, in `mongosh`:

```js
rs.initiate()
```

**Option B: Docker**

```bash
docker run -d --name mongo-rs -p 27017:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec -it mongo-rs mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
```

**Option C: MongoDB Atlas.** Atlas clusters are already replica sets, so you only need the connection string.

### 3. Configure environment

Copy `.env.example` to `.env` and adjust if needed:

```env
PORT=3000
MONGO_URI=mongodb://127.0.0.1:27017/coupon_redemption?replicaSet=rs0
# Optional, defaults to *
# CORS_ORIGIN=http://localhost:5173
```

| Variable      | Required | Default | Description                                   |
| ------------- | -------- | ------- | --------------------------------------------- |
| `MONGO_URI`   | yes      | none    | MongoDB connection string (must be a replica set) |
| `PORT`        | no       | `3000`  | HTTP port                                     |
| `CORS_ORIGIN` | no       | `*`     | Allowed CORS origin                           |

### 4. (Optional) Seed sample coupons

```bash
npm run seed
```

You can re-run this safely: it first deletes the earlier seed coupons and the orders made with them. It creates:

| Code        | Type      | Used / Max | Discount | State                          |
| ----------- | --------- | ---------- | -------- | ------------------------------ |
| `WELCOME10` | STANDARD  | 0 / 100    | 10%      | fresh                          |
| `SUMMER25`  | STACKABLE | 20 / 50    | 25%      | partially redeemed             |
| `LASTONE`   | STANDARD  | 4 / 5      | 15%      | one redemption left            |
| `SOLDOUT`   | STANDARD  | 3 / 3      | 50%      | exhausted                      |
| `EXPIRED20` | STANDARD  | 2 / 10     | 20%      | expired                        |
| `FLASH5`    | STACKABLE | 0 / 5      | 30%      | small cap, for concurrency tests |

### 5. Run the server

```bash
npm run dev     # with nodemon (auto-restart)
npm start       # plain node
```

Check that it's up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

---

## API

Base URL: `http://localhost:3000`

| Method | Path                       | Purpose                          |
| ------ | -------------------------- | -------------------------------- |
| GET    | `/health`                  | Health check                     |
| POST   | `/api/coupons`             | Create one or many coupons       |
| GET    | `/api/coupons/:code`       | Get redemption stats for a coupon |
| POST   | `/redeem`                  | Redeem a coupon for an order     |
| POST   | `/orders/:order_id/cancel` | Cancel an order and free its slot |

### Response format

Success:

```json
{ "success": true, "statusCode": 201, "message": "...", "data": { } }
```

Error:

```json
{ "success": false, "statusCode": 409, "errorCode": "COUPON_EXHAUSTED", "message": "...", "errors": [] }
```

Use `errorCode` to tell errors apart; several different errors share an HTTP status such as 409.

---

### `POST /api/coupons`: create coupons

The body can be a single coupon object, an array of coupons, or `{ "coupons": [...] }`. You can send at most 100 per request.

| Field              | Type    | Required | Notes                                         |
| ------------------ | ------- | -------- | --------------------------------------------- |
| `code`             | string  | yes      | Unique; trimmed and stored in UPPERCASE       |
| `max_redemptions`  | integer | yes      | ≥ 1, the total cap across all customers       |
| `discount_percent` | number  | yes      | 1–100                                         |
| `expires_at`       | date    | yes      | ISO date, must be in the future               |
| `type`             | string  | no       | `STANDARD` (default) or `STACKABLE`           |

Any other field, including `redemption_count`, is ignored.

```bash
curl -X POST http://localhost:3000/api/coupons \
  -H "Content-Type: application/json" \
  -d '[
    { "code": "NEWYEAR", "max_redemptions": 100, "discount_percent": 20, "expires_at": "2027-01-31T23:59:59Z" },
    { "code": "REFER5",  "max_redemptions": 1000, "discount_percent": 5, "expires_at": "2027-12-31T00:00:00Z", "type": "STACKABLE" }
  ]'
```

Each coupon is validated separately, so one bad coupon doesn't fail the whole batch:

| Status | Meaning                                                                  |
| ------ | ------------------------------------------------------------------------ |
| 201    | All coupons created                                                      |
| 207    | Some created, some failed; see `data.failed`                             |
| 400    | None created, at least one was invalid (`VALIDATION_ERROR`)              |
| 409    | None created, every code already exists (`COUPON_CODE_CONFLICT`)         |

`data` is `{ created: [...], failed: [{ index, code, errorCode, errors }] }`.

### `GET /api/coupons/:code`: coupon stats

```bash
curl http://localhost:3000/api/coupons/WELCOME10
```

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Coupon stats",
  "data": { "redeemed_count": 0, "remaining": 100, "max_redemptions": 100 }
}
```

- The count is exact at the moment of the request: it uses a linearizable read from the primary.
- An expired coupon reports `remaining: 0`.
- `redeemed_count + remaining` always equals `max_redemptions`.
- If the code doesn't exist, you get 404 `COUPON_NOT_FOUND`.

### `POST /redeem`: redeem a coupon

**Header `Idempotency-Key` is required.** Use a new unique value (for example a UUID) for each new redemption, and send the same value again when you retry that redemption.

| Field         | Type   | Required | Notes                                          |
| ------------- | ------ | -------- | ---------------------------------------------- |
| `code`        | string | yes      | Coupon code (case-insensitive)                 |
| `customer_id` | string | yes      |                                                |
| `order_id`    | string | yes      | Must be unique; the order is created by this call |
| `amount`      | number | no       | ≥ 0; if given, discount and final amount are calculated |

```bash
curl -X POST http://localhost:3000/redeem \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6f1c2a9e-0b7d-4c1e-9a55-2f3e8d1b7c40" \
  -d '{ "code": "WELCOME10", "customer_id": "cust_1", "order_id": "ord_1001", "amount": 250 }'
```

```json
{
  "success": true,
  "statusCode": 201,
  "message": "Coupon redeemed",
  "data": {
    "remaining": 99,
    "code": "WELCOME10",
    "customer_id": "cust_1",
    "order_id": "ord_1001",
    "discount_percent": 10,
    "amount": 250,
    "discount_amount": 25,
    "final_amount": 225
  }
}
```

The order is checked in this sequence: order already exists, then unknown code, then expired, then STANDARD already used by this customer, then no redemptions left.

| Status | `errorCode`                       | When                                              |
| ------ | --------------------------------- | ------------------------------------------------- |
| 400    | `IDEMPOTENCY_KEY_MISSING`         | No `Idempotency-Key` header                       |
| 400    | `VALIDATION_ERROR`                | Missing or invalid body fields                    |
| 404    | `COUPON_NOT_FOUND`                | Unknown coupon code                               |
| 410    | `COUPON_EXPIRED`                  | Coupon is past `expires_at`                       |
| 409    | `ORDER_ALREADY_EXISTS`            | `order_id` was already used                       |
| 409    | `COUPON_ALREADY_USED`             | STANDARD coupon already used by this customer     |
| 409    | `COUPON_EXHAUSTED`                | `max_redemptions` reached                         |
| 409    | `COUPON_ALREADY_REDEEMED`         | Replay of a key whose request already succeeded   |
| 409    | `IDEMPOTENCY_REQUEST_IN_PROGRESS` | Another request with this key is still running    |
| 422    | `IDEMPOTENCY_KEY_REUSED`          | Same key was sent with a different body           |

#### How retries behave with `Idempotency-Key`

- **Same key, same body, first call succeeded:** you get 409 `COUPON_ALREADY_REDEEMED`. Nothing is redeemed again. The original successful response is in `errors[0].original_response`, so a client that lost the first response can still read it.
- **Same key, same body, first call was rejected** (for example 410 expired): you get the same error again.
- **Same key, different body:** you get 422 `IDEMPOTENCY_KEY_REUSED`.
- **First call still running:** you get 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`. Retry shortly. A key left in progress by a crashed request can be taken over after 30 seconds.
- **First call failed with a server error (5xx):** nothing was committed and the key is released, so you can retry with the same key.
- Replayed responses include the header `Idempotent-Replayed: true`.
- Keys are kept for 24 hours and then removed automatically (TTL index).

### `POST /orders/:order_id/cancel`: cancel an order

```bash
curl -X POST http://localhost:3000/orders/ord_1001/cancel
```

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Order cancelled",
  "data": {
    "order_id": "ord_1001",
    "status": "CANCELLED",
    "cancelled_at": "2026-10-06T10:00:00.000Z",
    "already_cancelled": false,
    "coupon_slot_released": true,
    "coupon_code": "WELCOME10"
  }
}
```

- The coupon's `redemption_count` is decremented **once per order**. Calling cancel again returns 200 with `already_cancelled: true` and changes nothing.
- After cancelling, the same customer can use a STANDARD coupon again.
- If the order doesn't exist, you get 404 `ORDER_NOT_FOUND`.

---

## Testing with Postman

Import [postman/coupon_redemption.postman_collection.json](postman/coupon_redemption.postman_collection.json) into Postman.

- The `baseUrl` collection variable defaults to `http://localhost:3000`.
- Run the **"Start new test run (health check)"** request first. It generates a fresh `runId`, which later requests use for coupon codes, order IDs and idempotency keys, so you can run the collection many times without collisions.
- Then use the Collection Runner to run everything in order. The collection covers coupon creation (201/207/400/409), stats, redemption success and each failure case, idempotent replays, STACKABLE reuse, expiry, and cancellation (including cancelling twice).

---

## Project structure

```
index.js                     Entry point: loads .env, connects to MongoDB, starts Express
scripts/seed.js              Sample coupon seeder (npm run seed)
src/
  app.js                     Express app: middleware, routes, 404 and error handler
  db/connect.js              MongoDB connection, replica-set check, index sync
  db/transaction.js          runInTransaction() helper and transaction options
  routes/                    Route definitions (coupons, redeem, orders)
  controllers/               Request handlers and business logic
  models/                    Mongoose models: Coupon, Order, Customer, IdempotencyKey
  middlewares/errorHandler.js  Converts any thrown error into the JSON error format
  services/                  APIError, APIResponse, asyncHandler, error codes
postman/                     Postman collection
```

## Troubleshooting

- **`MongoDB is running standalone. Transactions require a replica set`**: start `mongod` with `--replSet rs0`, run `rs.initiate()` once, and add `?replicaSet=rs0` to `MONGO_URI`.
- **`MONGO_URI is not defined in .env`**: create `.env` from `.env.example`.
- **Docker replica set unreachable from the host**: initiate the set with `host: '127.0.0.1:27017'` as in the Docker example above, not the container hostname.
