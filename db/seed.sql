USE campus_marketplace;

INSERT INTO users (name,email,roll_no,phone,hostel) VALUES
 ('Dev Kaushik','dev@campus.edu','2501730247','9000000001','Block A'),
 ('Aryan Giri','aryan@campus.edu','2501730101','9000000002','Block A'),
 ('Riya Sharma','riya@campus.edu','2501730155','9000000003','Block C'),
 ('Karan Mehta','karan@campus.edu','2501730189','9000000004','Block B'),
 ('Sneha Verma','sneha@campus.edu','2501730210','9000000005','Block C'),
 ('Aman Singh','aman@campus.edu','2501730233','9000000006','Block B');

INSERT INTO categories (name,description) VALUES
 ('Books','Textbooks and reference books'),
 ('Electronics','Calculators, laptops, gadgets'),
 ('Furniture','Study tables, chairs, shelves'),
 ('Stationery','Drafters, lab coats, notebooks'),
 ('Cycles & Vehicles','Bicycles and accessories'),
 ('Clothing','Hoodies, jackets, uniforms');

INSERT INTO items (seller_id,category_id,title,description,price,`condition`,status) VALUES
 (1,1,'Database System Concepts (7th Ed)','Silberschatz, few highlights',450,'Good','Available'),
 (2,1,'Engineering Mathematics - B.S. Grewal','Clean copy',250,'Like New','Available'),
 (3,2,'Casio fx-991EX Calculator','Works perfectly, with cover',700,'Like New','Available'),
 (4,2,'Dell Inspiron Laptop i5 8GB','2 years old, battery 3 hrs',24000,'Good','Available'),
 (5,3,'Study Table (foldable)','Sturdy, fits in hostel room',900,'Good','Available'),
 (6,5,'Hero Sprint Bicycle','Single speed, new tyres',3500,'Fair','Available'),
 (1,4,'Mini Drafter','Used for one semester',200,'Good','Available'),
 (2,2,'Arduino Uno + Sensor Kit','Great for embedded projects',1200,'Like New','Available'),
 (3,6,'Black Hoodie (L)','Worn twice',500,'Like New','Available'),
 (4,1,'Operating System Concepts','Galvin, 10th Ed',400,'Good','Available'),
 (5,4,'Lab Coat (M)','Washed, no stains',150,'Good','Available'),
 (6,3,'Plastic Chair','Slightly scratched',300,'Fair','Available');

-- Trigger trg_mark_sold flips items 7 and 8 to Sold
INSERT INTO transactions (item_id,buyer_id,price_paid,payment_mode,txn_date) VALUES
 (7,3,180,'Cash','2026-10-10 14:20:00'),
 (8,5,1100,'UPI','2026-10-15 18:05:00');

INSERT INTO reviews (txn_id,rating,comment) VALUES
 (1,5,'Smooth deal, item as described'),
 (2,4,'Good kit, a bit late to meet');

INSERT INTO wishlist (user_id,item_id) VALUES (1,3),(1,4),(2,5),(3,10);
