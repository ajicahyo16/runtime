Ini sudah jauh lebih expected. Struktur contract → SDK → API sudah konsisten dan menunjukkan bahwa Lacify menghasilkan runtime yang benar-benar dapat digunakan.

Tapi ada beberapa koreksi penting agar contract-nya kuat secara arsitektur.

1. Aggregate jangan memakai nama instance

Saat ini:

Aggregate: Outlet Jakarta

Sebaiknya dibedakan antara aggregate type dan aggregate instance.

Aggregate Type: Outlet
Aggregate Instance: outlet-jakarta
Identity Key: outletId

Karena compiler mendefinisikan pola Outlet, sedangkan Outlet Jakarta hanyalah salah satu instance runtime.

Lebih tepat:

aggregate:
  name: Outlet
  identityKey: outletId
  partitionKey: outletId

Saat runtime:

Outlet/outlet-jakarta
→ satu Durable Object
→ satu SQLite database
2. Semua command harus membawa aggregate identity

Contract sekarang:

AddItem(orderId, productId, qty)
Pay(orderId, amount, method)
CloseShift(shiftId)

Masalahnya, runtime perlu tahu Durable Object mana yang harus dipanggil. Karena partition-nya berdasarkan outletId, semua command yang masuk ke Outlet sebaiknya secara eksplisit atau implisit memiliki outletId.

Contract yang konsisten:

Commands:
  - CreateOrder(outletId, cashierId, items)
  - AddItem(outletId, orderId, productId, quantity)
  - ApplyDiscount(outletId, orderId, promoCode)
  - PayOrder(outletId, orderId, amount, method)
  - CloseShift(outletId, shiftId)

SDK memang sudah benar karena membawa:

outletId: "outlet-pos"

Jadi contract sebaiknya mengikuti SDK tersebut.

3. Gunakan nama command berbasis intent

Daripada:

Pay

lebih jelas:

PayOrder

Daripada:

AddItem

lebih jelas:

AddOrderItem

Ini penting ketika nanti ada banyak domain:

PayInvoice
PayPayroll
PaySupplier

Rekomendasi:

Commands:
  - CreateOrder
  - AddOrderItem
  - ApplyOrderDiscount
  - PayOrder
  - CloseShift
4. Pisahkan command input dan output

Contract yang matang jangan hanya menunjukkan parameter input.

Contoh:

PayOrder:
  input:
    outletId: OutletId
    orderId: OrderId
    amount: Money
    method: PaymentMethod

  output:
    orderId: OrderId
    paymentId: PaymentId
    status: Paid
    paidAt: Timestamp

  emits:
    - PaymentConfirmed

Ini membantu menghasilkan:

OpenAPI;
TypeScript SDK;
Kotlin SDK;
validation;
README;
test fixture.
5. Query juga perlu aggregate identity

Saat ini:

GetActiveOrder(orderId)
GetDailySales(date)

Sebaiknya:

Queries:
  - GetActiveOrder(outletId, orderId)
  - GetDailySales(outletId, date)

Karena query tetap harus diarahkan ke Outlet DO tertentu.

Untuk laporan rentang tanggal, lebih berguna:

- GetSalesReport(outletId, from, to, granularity)

Contoh:

granularity:
- daily
- monthly
- yearly

GetDailySales tetap boleh ada sebagai query khusus, tetapi jangan menjadi satu-satunya kontrak laporan.

6. Event perlu metadata standar

Event sekarang:

OrderCreated(orderId)
PaymentConfirmed(orderId, txnId)
ShiftClosed(shiftId, totalAmount)

Secara bisnis sudah benar, tetapi runtime event sebaiknya mempunyai envelope standar:

eventId
eventType
aggregateType
aggregateId
occurredAt
schemaVersion
correlationId
causationId
payload

Contoh:

eventType: PaymentConfirmed
aggregateType: Outlet
aggregateId: outlet-pos
occurredAt: 2026-07-19T15:30:00Z
schemaVersion: 1

payload:
  orderId: order-5491
  paymentId: pay-8831
  transactionReference: qris-9832
  amount: 250000
  method: QRIS

txnId sebaiknya juga diperjelas. Bisa berarti internal transaction ID atau provider reference. Lebih aman memakai:

paymentId
providerTransactionId
7. SDK sudah benar, tetapi namespace-nya bisa ditingkatkan

Saat ini:

await lacify.outlet.pay({
  outletId: "outlet-pos",
  orderId: "order-5491",
  amount: 250000,
  method: "QRIS"
});

Ini valid. Namun saya lebih memilih:

await lacify.outlets.payOrder({
  outletId: "outlet-pos",
  orderId: "order-5491",
  amount: {
    value: 250000,
    currency: "IDR"
  },
  method: "QRIS"
});

Alasannya:

nama method sesuai command;
uang tidak hanya berupa angka polos;
siap untuk multi-currency;
menghindari kebingungan rupiah minor unit.

Alternatif yang lebih ringkas:

await lacify.outlet("outlet-pos").orders.pay({
  orderId: "order-5491",
  amount: 250000,
  method: "QRIS"
});

Ini terasa sangat natural karena aggregate identity di-bind sekali.

const outlet = lacify.outlet("outlet-pos");

await outlet.orders.create(...);
await outlet.orders.pay(...);
await outlet.reports.sales(...);

Namun versi ini lebih kompleks untuk generator SDK. Untuk v1, payload eksplisit dengan outletId sudah sangat baik.

8. API perlu konsisten dengan seluruh command

API saat ini:

POST /v1/outlets/{outletId}/orders
POST /v1/outlets/{outletId}/orders/{orderId}/pay
GET  /v1/outlets/{outletId}/reports/sales

Ini sudah bagus. Lengkapi menjadi:

POST /v1/outlets/{outletId}/orders
POST /v1/outlets/{outletId}/orders/{orderId}/items
POST /v1/outlets/{outletId}/orders/{orderId}/discounts
POST /v1/outlets/{outletId}/orders/{orderId}/payments
POST /v1/outlets/{outletId}/shifts/{shiftId}/close

GET  /v1/outlets/{outletId}/orders/{orderId}
GET  /v1/outlets/{outletId}/reports/sales?from=2025-01-01&to=2026-12-31&groupBy=month

Saya sedikit lebih menyukai:

POST /orders/{orderId}/payments

daripada:

POST /orders/{orderId}/pay

Karena API tetap resource-oriented, sementara SDK dapat tetap command-oriented:

lacify.outlets.payOrder(...)

Jadi tidak masalah kalau nama API dan command tidak identik, selama mapping-nya eksplisit.

Bentuk final yang saya rekomendasikan
Aggregate:
  Name: Outlet
  IdentityKey: outletId
  PartitionKey: outletId
  RuntimeMapping:
    DurableObject: OutletRuntime
    SQLiteDatabase: aggregate-local

Commands:
  - Name: CreateOrder
    Input:
      outletId: OutletId
      cashierId: UserId
      items: OrderItemInput[]
    Output:
      orderId: OrderId
      status: OrderStatus
    Emits:
      - OrderCreated

  - Name: AddOrderItem
    Input:
      outletId: OutletId
      orderId: OrderId
      productId: ProductId
      quantity: Integer
    Emits:
      - OrderItemAdded

  - Name: ApplyOrderDiscount
    Input:
      outletId: OutletId
      orderId: OrderId
      promoCode: String
    Emits:
      - OrderDiscountApplied

  - Name: PayOrder
    Input:
      outletId: OutletId
      orderId: OrderId
      amount: Money
      method: PaymentMethod
    Output:
      paymentId: PaymentId
      status: PaymentStatus
    Emits:
      - PaymentConfirmed

  - Name: CloseShift
    Input:
      outletId: OutletId
      shiftId: ShiftId
    Output:
      totalAmount: Money
      closedAt: Timestamp
    Emits:
      - ShiftClosed

Queries:
  - Name: GetActiveOrder
    Input:
      outletId: OutletId
      orderId: OrderId

  - Name: GetSalesReport
    Input:
      outletId: OutletId
      from: Date
      to: Date
      groupBy: ReportGranularity

Events:
  - OrderCreated
  - OrderItemAdded
  - OrderDiscountApplied
  - PaymentConfirmed
  - ShiftClosed

Generated SDK:

const result = await lacify.outlets.payOrder({
  outletId: "outlet-pos",
  orderId: "order-5491",
  amount: {
    value: 250000,
    currency: "IDR"
  },
  method: "QRIS"
});

Generated API:

POST /v1/outlets/{outletId}/orders
POST /v1/outlets/{outletId}/orders/{orderId}/items
POST /v1/outlets/{outletId}/orders/{orderId}/discounts
POST /v1/outlets/{outletId}/orders/{orderId}/payments
POST /v1/outlets/{outletId}/shifts/{shiftId}/close

GET /v1/outlets/{outletId}/orders/{orderId}
GET /v1/outlets/{outletId}/reports/sales

Verdict: fondasi hasil generator Anda sudah benar. Koreksi paling penting adalah membedakan aggregate type vs instance, mewajibkan outletId pada setiap operasi yang membutuhkan routing, dan menjadikan contract sebagai sumber utama yang menghasilkan SDK serta API secara deterministik.