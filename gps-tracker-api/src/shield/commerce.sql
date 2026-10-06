CREATE TABLE faqs (
 id bigserial PRIMARY KEY, category text NOT NULL, question text NOT NULL, answer text NOT NULL,
 published boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
 position integer NOT NULL DEFAULT 0, revision integer NOT NULL DEFAULT 1,
 updated_by bigint REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE point_orders (
 id text PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), amount bigint NOT NULL CHECK(amount IN (10000,30000,50000,100000)),
 idempotency_key uuid NOT NULL, payment_key text UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirming','unknown','paid')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
 UNIQUE(user_id,idempotency_key)
);
CREATE INDEX point_orders_user_idx ON point_orders(user_id,created_at DESC);
ALTER TABLE credit_entries DROP CONSTRAINT credit_entries_kind_check;
ALTER TABLE credit_entries ADD CONSTRAINT credit_entries_kind_check CHECK(kind IN ('adjustment','charge','refund','payment'));

INSERT INTO faqs(category,question,answer,published,position) VALUES
('시작하기','처음 연결할 때 무엇이 필요한가요?','쉴드와 Arduino Uno, LTE·GNSS 안테나, 사용 가능한 USIM을 준비하세요. 전원을 끈 상태에서 연결하고 시작가이드의 순서대로 진행해 주세요.',true,0),
('시작하기','초대코드와 장치 등록 코드는 다른가요?','초대코드는 계정을 만들 때, 제품의 일회용 등록 코드는 내 장치를 계정에 연결할 때 사용합니다. 이미 사용한 등록 코드는 다시 사용할 수 없습니다.',true,10),
('데이터','데이터가 없는데 그래프가 보여요.','장치가 없거나 아직 수신하지 않은 경우에는 “데모 데이터” 표시와 함께 합성 데이터를 보여드립니다. 내 장치의 실제 측정값과는 별개입니다.',true,20),
('장치','오프라인이면 전원이 꺼진 건가요?','온라인은 최근 3분 안에 서버가 데이터를 받은 상태입니다. 오프라인은 수신이 멈춘 상태로 전원·망 연결·전송 주기를 함께 확인해 주세요. 전원 OFF를 직접 확인한 것은 아닙니다.',true,30),
('장치','통신은 되는데 위치가 미수신이에요.','SIM7080G 내장 GNSS가 위치를 확보해야 합니다. GNSS 안테나를 하늘이 보이는 곳에 고정하고 기다려 주세요. 센서/통신 수신과 GNSS 측위는 각각 확인합니다.',true,40),
('데이터','다른 센서를 연결해도 되나요?','가능합니다. 서버에 센서 이름·단위·값을 함께 보내면 데이터 화면이 해당 센서에 맞춰 표시됩니다. 센서 구성이나 단위가 바뀌면 새 구성 키를 사용해 이전 기록을 보존하세요.',true,50),
('USIM·포인트','USIM은 어떻게 충전하나요?','내 장치 또는 요금 안내에서 USIM 충전창을 여세요. 보유 포인트로 요청하면 관리자가 확인 후 처리합니다. 판매 상품은 요금 안내에서 확인할 수 있습니다.',true,60),
('USIM·포인트','온라인 포인트 충전과 유료 프로젝트 구매가 가능한가요?','포인트 충전창에서 금액과 결제 후 잔액을 확인할 수 있습니다. 온라인 결제와 프로젝트 판매는 준비 상태에 따라 이용할 수 있습니다.',true,70),
('데이터','GPS 서비스 계정과 같이 쓰나요?','Shield는 계정과 데이터를 별도로 관리합니다. Shield 전용 계정으로 로그인하고 전용 장치 ID와 키를 사용하세요.',true,80);
