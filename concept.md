Nilai utama web app Lacify seharusnya adalah:

Developer mendeskripsikan aplikasi bisnis, lalu Lacify menghasilkan, menjalankan, mengubah, dan memonitor runtime-nya tanpa developer menulis struktur Durable Object secara manual.

Yang sebenarnya dibuat di web app
1. Project Builder

User membuat project:

POS Restaurant
CRM Sales
Inventory Warehouse
Booking Clinic
HR Company

Lalu memilih template atau mulai kosong.

Web app menyimpan Project Spec, bukan langsung data transaksi.

Contoh:

project: restaurant-pos

aggregates:
  - name: Outlet
    identityKey: outletId

objects:
  - Order
  - Product
  - Payment
  - Customer
  - Shift

Project Spec ini menjadi source of truth untuk compiler.

2. Business Object Designer

Developer tidak membuat tabel SQLite satu per satu lewat code.

Ia membuat Business Object:

Order

Properties:

id
number
status
subtotal
tax
total
createdAt

Actions:

CreateOrder
AddItem
ApplyDiscount
Pay
Cancel
Refund

States:

Draft
Open
Paid
Cancelled
Refunded

Web app kemudian menghasilkan:

schema SQLite;
command contracts;
validation;
reducers atau handlers;
indexes;
summary tables;
API endpoints;
SDK types;
documentation.

Jadi web app adalah modeling environment, bukan database editor biasa.

3. Aggregate Boundary Designer

Ini bagian paling penting.

User menentukan:

Outlet
=
Aggregate Root

Di dalamnya terdapat:

Orders
Payments
Products
Inventory
Shifts
Customers
Summary Tables

Lacify lalu memetakan:

Outlet Aggregate
      ↓
Durable Object
      ↓
SQLite database

Developer tidak perlu menulis sendiri:

env.OUTLET_DO.idFromName(outletId)
env.OUTLET_DO.get(id)

Runtime SDK yang mengurusnya.

4. Workflow Designer

Developer bisa membuat flow seperti:

Create Order
    ↓
Validate Product
    ↓
Reserve Stock
    ↓
Save Order
    ↓
Update Daily Sales
    ↓
Return Result

Atau:

Booking Created
    ↓
Check Availability
    ↓
Reserve Time Slot
    ↓
Send Confirmation

Bisa melalui visual builder, AI prompt, atau code editor.

Web app harus menghasilkan kontrak runtime yang deterministik, bukan sekadar workflow visual yang terpisah dari code.

5. AI App Builder

User bisa memberi prompt:

Buatkan POS restoran dengan dine-in, takeaway, shift kasir,
discount per item, tax, payment cash dan QRIS, serta laporan harian.

AI tidak langsung menulis code acak.

AI harus menghasilkan proposal terstruktur:

Aggregates
Business Objects
Properties
Actions
States
Indexes
Summary Tables
Permissions
API Contracts

User mereview perubahan tersebut, lalu menekan:

Compile
Preview
Deploy

Ini salah satu alasan utama web app Lacify perlu ada.

6. Runtime Compiler

Web app mengirim Project Spec ke compiler.

Compiler menghasilkan:

SQLite schema
Durable Object classes
Worker routes
Runtime manifest
Migration plan
OpenAPI specification
TypeScript/Kotlin SDK
README

Jadi developer tidak perlu membuat runtime Durable Object dari nol.

Flow-nya:

Studio
  ↓
Project Spec
  ↓
Compiler
  ↓
Runtime Bundle
  ↓
Cloudflare Deploy
7. API Explorer

Setelah deploy, developer mendapatkan API seperti:

POST /v1/outlets/{outletId}/orders
POST /v1/outlets/{outletId}/orders/{orderId}/pay
GET  /v1/outlets/{outletId}/reports/sales

Web app menyediakan:

endpoint documentation;
request builder;
response preview;
authentication setup;
SDK snippets;
API keys;
environment variables;
webhook configuration.

Developer frontend memang tetap memakai API, tetapi API tersebut dihasilkan oleh Lacify, bukan dibuat manual semuanya.

8. Data Explorer

Bukan editor SQL bebas sebagai fitur utama, tetapi explorer berbasis domain:

Outlet Jakarta
├── Orders
├── Products
├── Customers
├── Payments
├── Shifts
└── Reports

Developer bisa:

melihat record;
mencari order;
membuka detail transaksi;
melihat aggregate state;
melakukan permitted admin action;
melihat audit trail.

Untuk keamanan, perubahan data harus melewati command runtime, bukan mengedit row SQLite sembarangan.

Contoh yang benar:

Refund Order

Bukan:

UPDATE orders SET status = 'refunded';
9. Migration and Versioning

Ketika developer meminta:

Tambahkan loyalty points ke Customer

Lacify menghasilkan:

Schema change
Migration
Backward compatibility report
API impact
Summary-table impact
Rollback plan

Web app memperlihatkan diff:

Customer
+ loyaltyPoints: integer

Actions
+ AddLoyaltyPoints
+ RedeemLoyaltyPoints

Kemudian developer bisa:

Review
Compile
Test
Deploy
Rollback

Tanpa ini, perubahan schema lewat AI sangat berbahaya.

10. Monitoring

Web app juga menjadi console untuk:

Requests
Errors
Latency
DO duration
SQLite size
Reads/Writes
Aggregate health
Deploy history
Migration status
R2 usage
Cloud Run jobs
BigQuery projection status

Namun monitoring adalah fitur pendukung, bukan nilai inti platform.

Apa yang tetap dibuat lewat code?

Lacify sebaiknya tidak menghilangkan code sepenuhnya.

Developer masih bisa menulis:

custom validation;
complex pricing logic;
integrations;
UI aplikasi;
custom connectors;
custom reports;
extension modules.

Contoh:

export const calculateDiscount: BusinessRule = ({ order, customer }) => {
  if (customer.tier === "gold" && order.subtotal >= 500_000) {
    return order.subtotal * 0.1;
  }

  return 0;
};

Tetapi lifecycle, persistence, routing, schema, migration, API contract, dan observability disediakan runtime.

Posisi produk Lacify yang benar

Bukan:

Cloudflare API Dashboard

Bukan juga:

SQLite GUI

Tetapi:

AI-Native Business Runtime Platform

Yang menjembatani:

Business Requirements
        ↓
Business Model
        ↓
Runtime Contracts
        ↓
Durable Objects + SQLite
        ↓
Generated API and SDK
Pengalaman developer yang ideal

Developer memberi prompt:

Buat inventory multi-warehouse dengan stock transfer dan stock opname.

Lacify menampilkan proposal:

Aggregate:
Warehouse

Objects:
Product
StockItem
StockMovement
StockTransfer
StockOpname

Actions:
ReceiveStock
TransferStock
AdjustStock
CompleteStockOpname

Summary:
daily_stock_movement
inventory_balance

Developer menyetujui, lalu Lacify:

Compile
Deploy
Generate API
Generate SDK
Generate README

Developer frontend hanya memakai:

await lacify.inventory.transferStock({
  sourceWarehouseId,
  destinationWarehouseId,
  productId,
  quantity,
});

Jadi benar bahwa pada akhirnya aplikasi menggunakan API. Tetapi web app Lacify adalah tempat API, schema, business rules, deployment, migration, dan documentation tersebut diciptakan serta dikelola. Tanpa itu, Lacify hanya menjadi wrapper tipis Cloudflare dan hampir tidak punya alasan kuat untuk digunakan.