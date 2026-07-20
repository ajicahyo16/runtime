1 Business Aggregate = 1 Durable Object = 1 SQLite Database

Perhatikan kata Business Aggregate, bukan Actor secara umum. Saya sengaja mengganti istilah "Actor" yang terlihat teknis menjadi "Business Aggregate" karena lebih sesuai dengan DDD dan lebih mudah dipahami pengguna Lacify.

Jadi secara internal:

Business Aggregate
        ↓
Durable Object
        ↓
SQLite
Contoh POS

Bukan:

Order
↓
1 DO

Tetapi:

Outlet
↓
1 DO
↓
SQLite

orders
order_items
payments
customers
inventory
shifts
daily_sales
monthly_sales

Semua transaksi milik outlet tersebut berada di SQLite yang sama.

Contoh Inventory
Warehouse
↓
1 DO
↓
SQLite

products
stock
stock_movements
suppliers
purchase_orders
Contoh Booking
BookingCalendar
↓
1 DO
↓
SQLite

reservations
time_slots
resources
availability
Contoh HR
Company
↓
1 DO
↓
SQLite

employees
attendance
leave
payroll
Kenapa bukan 1 Order = 1 DO?

Awalnya kita sempat mempertimbangkan itu.

Tetapi muncul masalah:

Report menjadi sulit.
Query lintas order harus membangunkan ribuan DO.
SQL kehilangan keunggulannya.
Banyak operasi bisnis (stok, laporan, shift) sebenarnya berada dalam satu batas konsistensi (consistency boundary).

Sedangkan jika:

Outlet
↓
1 DO

maka:

SELECT SUM(total)
FROM orders
WHERE created_at BETWEEN ...

langsung selesai.

Jadi Actor itu apa?

Secara internal Runtime:

Business Aggregate
        ↓
Actor Runtime
        ↓
Durable Object
        ↓
SQLite

Developer cukup melihat:

Outlet
Warehouse
Company
BookingCalendar

AI Agent yang menerjemahkan menjadi:

Outlet
↓

Actor

↓

Durable Object

↓

SQLite
Aturan yang saya rekomendasikan masuk ADR
ADR-RV1-002

One Business Aggregate
=
One Durable Object
=
One SQLite Database

The aggregate is the unit of consistency, concurrency, persistence, and lifecycle.

All business state belonging to the aggregate is stored inside its SQLite database.

Business transactions should complete within a single aggregate whenever possible.
Satu catatan penting

Saya akan menghindari menulis:

1 Actor = 1 DO

Karena nanti akan membingungkan ketika masuk ke Runtime v2 (chat, presence, multiplayer). Di sana bisa saja ada actor yang bersifat lebih teknis atau memiliki pola hidup berbeda.

Sedangkan jika ADR ditulis:

1 Business Aggregate = 1 Durable Object

maka Runtime v1 tetap bersih, fokus pada aplikasi bisnis (POS, ERP, Inventory, CRM, Booking, HR), dan nanti Runtime v2 bisa memperkenalkan actor realtime tanpa merusak aturan yang sudah ada. Menurut saya ini akan membuat evolusi arsitektur Lacify jauh lebih mulus.