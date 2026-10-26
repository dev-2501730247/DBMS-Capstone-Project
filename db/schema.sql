-- Campus Marketplace Database : Schema (MySQL 8, InnoDB, 3NF)
DROP DATABASE IF EXISTS campus_marketplace;
CREATE DATABASE campus_marketplace CHARACTER SET utf8mb4;
USE campus_marketplace;

CREATE TABLE users (
  user_id    INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  email      VARCHAR(120) NOT NULL UNIQUE,
  roll_no    VARCHAR(20)  NOT NULL UNIQUE,
  phone      VARCHAR(15),
  hostel     VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE categories (
  category_id INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(60) NOT NULL UNIQUE,
  description VARCHAR(200)
) ENGINE=InnoDB;

CREATE TABLE items (
  item_id     INT AUTO_INCREMENT PRIMARY KEY,
  seller_id   INT NOT NULL,
  category_id INT NOT NULL,
  title       VARCHAR(150) NOT NULL,
  description TEXT,
  price       DECIMAL(10,2) NOT NULL,
  `condition` ENUM('New','Like New','Good','Fair') NOT NULL DEFAULT 'Good',
  status      ENUM('Available','Sold','Removed') NOT NULL DEFAULT 'Available',
  listed_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_price CHECK (price >= 0),
  CONSTRAINT fk_items_seller   FOREIGN KEY (seller_id)   REFERENCES users(user_id)          ON DELETE CASCADE,
  CONSTRAINT fk_items_category FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE transactions (
  txn_id       INT AUTO_INCREMENT PRIMARY KEY,
  item_id      INT NOT NULL UNIQUE,            -- one item can be sold only once
  buyer_id     INT NOT NULL,
  price_paid   DECIMAL(10,2) NOT NULL,
  payment_mode ENUM('Cash','UPI','Card') NOT NULL,
  txn_date     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_paid CHECK (price_paid >= 0),
  CONSTRAINT fk_txn_item  FOREIGN KEY (item_id)  REFERENCES items(item_id) ON DELETE RESTRICT,
  CONSTRAINT fk_txn_buyer FOREIGN KEY (buyer_id) REFERENCES users(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE reviews (
  review_id  INT AUTO_INCREMENT PRIMARY KEY,
  txn_id     INT NOT NULL UNIQUE,              -- one review per transaction
  rating     TINYINT NOT NULL,
  comment    VARCHAR(300),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_review_txn FOREIGN KEY (txn_id) REFERENCES transactions(txn_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE wishlist (
  user_id  INT NOT NULL,
  item_id  INT NOT NULL,
  added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, item_id),
  CONSTRAINT fk_wish_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_wish_item FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Indexes for common lookups
CREATE INDEX idx_items_seller   ON items(seller_id);
CREATE INDEX idx_items_category ON items(category_id);
CREATE INDEX idx_items_status   ON items(status);
CREATE INDEX idx_txn_buyer      ON transactions(buyer_id);

-- Triggers: business rules enforced inside the database
DELIMITER $$

CREATE TRIGGER trg_validate_purchase
BEFORE INSERT ON transactions
FOR EACH ROW
BEGIN
  DECLARE v_status VARCHAR(20);
  DECLARE v_seller INT;
  SELECT status, seller_id INTO v_status, v_seller FROM items WHERE item_id = NEW.item_id;
  IF v_status <> 'Available' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Item is not available for sale';
  END IF;
  IF v_seller = NEW.buyer_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Seller cannot buy their own item';
  END IF;
END$$

CREATE TRIGGER trg_mark_sold
AFTER INSERT ON transactions
FOR EACH ROW
BEGIN
  UPDATE items SET status = 'Sold' WHERE item_id = NEW.item_id;
  DELETE FROM wishlist WHERE item_id = NEW.item_id;
END$$

DELIMITER ;

-- Views
CREATE VIEW v_item_details AS
SELECT i.item_id, i.title, i.description, i.price, i.`condition`, i.status, i.listed_at,
       c.category_id, c.name AS category,
       u.user_id AS seller_id, u.name AS seller, u.hostel
FROM items i
JOIN categories c ON c.category_id = i.category_id
JOIN users u      ON u.user_id     = i.seller_id;

CREATE VIEW v_seller_stats AS
SELECT u.user_id, u.name,
       COUNT(DISTINCT i.item_id)                              AS items_listed,
       COUNT(DISTINCT CASE WHEN i.status = 'Sold' THEN i.item_id END) AS items_sold,
       COALESCE(SUM(t.price_paid), 0)                         AS revenue,
       ROUND(AVG(r.rating), 2)                                AS avg_rating
FROM users u
LEFT JOIN items i        ON i.seller_id = u.user_id
LEFT JOIN transactions t ON t.item_id   = i.item_id
LEFT JOIN reviews r      ON r.txn_id    = t.txn_id
GROUP BY u.user_id, u.name;
