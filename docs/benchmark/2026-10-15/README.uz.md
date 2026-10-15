# Korporativ avtomobil (법인차) · Rent-a-car (렌트카) boshqaruv sahifalari bo'yicha benchmark (2026-10-15)

> Maqsad: `법인차 운영` va `렌트카 운영` akkaunt turlarining boshqaruv sahifalari uchun dizayn va funksiyalar yo'nalishini belgilash.
> Qamrov: asosan korporativ avtomobil va rent-a-car. Yetkazib berish (배달) va GPS terminal xizmatlari faqat ma'lumot uchun.
> Asos qilingan kod: `server/dev-aligned-20261015` (`120a144`, dev server bilan bir xil).
> Koreyscha asl nusxa: [README.md](README.md)

---

## 0. Bizning hozirgi sahifalar

| Akkaunt turini tanlash | Korporativ avtomobil | Rent-a-car |
|---|---|---|
| ![](00_ours_account_type.png) | ![](00_ours_corporate.webp) | ![](00_ours_rentcar.webp) |

**Allaqachon bor funksiyalar** (kod bo'yicha)

- Korporativ avtomobil (`CorporatePanel.jsx`):
  - Bo'limlar: Holat (운영 현황), Avtomobillar (차량 관리), Bron (차량 예약), Yurish hisoboti (운행 리포트), Haydovchilar (운전자), Sozlamalar (설정).
  - Yurish hisobotini soliq qo'mitasi shaklida (국세청 별지 73호) yoki o'zimizning shaklda PDF/Excel sifatida yuklab olish.
  - Har bir yurish uchun maqsad, haydovchi va yoqilg'ini kiritish.
  - Texnik xizmat, sug'urta va ko'rik muddatiga 30 kun qolganda ogohlantirish.
  - Avtomobil hujjatlarini yuklash.
- Rent-a-car (`RentcarPanel.jsx`):
  - Bo'limlar: Holat, Shartnomalar (계약 관리), Qaytarish jadvali (반납 일정, kalendar), Ijarachilar (임차인), Sozlamalar.
  - Ijarachilar uchun qora ro'yxat: ogohlantirish yoki bloklash.
  - Topshirish va qaytarish uchun QR havola, unda rasm, yoqilg'i darajasi va probegni yozib qo'yish.
  - Hisob-fakturani yuklab olish.

**Hozirgi sahifalardagi muammolar**

1. **Korporativ avtomobilning bosh sahifasi bo'sh ko'rinadi.** Bron 0 ta va ko'rik 0 ta bo'lsa, ikkita bo'sh blok ekranning ko'p qismini egallaydi.
2. **Xarita (GPS) boshqaruv sahifasidan ajralgan.** Rent-a-car'da har bir qatorda faqat `Xarita` (지도) tugmasi bor. Korporativ avtomobilda esa birinchi ekranda joylashuv umuman ko'rinmaydi.
3. **Korporativ avtomobilning asosiy qiymati birinchi ekranda ko'rinmaydi.** Yurish jurnalining avtomatik yozilishi va yoqilg'i xarajati akkaunt turi tavsifida yozilgan, lekin "Holat" sahifasida yo'q.
4. **Ulanish holati shartnoma bilan bog'lanmagan.** Rent-a-car avtomobillar ro'yxatida `Joylashuv kechikmoqda` va `Oflayn` holatlari ko'rinadi. Lekin ular shartnoma holati bilan bog'langan ogohlantirish bermaydi. Masalan, "ijarada, lekin 30 kundan beri oflayn" degan ogohlantirish yo'q.

---

## 1. Benchmark qilingan xizmatlar

| Xizmat | Soha | Nimasi foydali |
|---|---|---|
| **RentDesk (휴비넷)** | Koreya, rent-a-car ERP | Xarita va ro'yxat bitta ekranda, mobil orqali avtomobil ko'rigi, elektron shartnoma, sarf materiallari haqida ogohlantirish |
| **SK렌터카 스마트링크** | Koreya, korporativ avtomobil monitoringi | Soliq qo'mitasi shaklida yurish jurnalini avtomatik yozish, yoqilg'i va Hi-pass xarajatlarini birlashtirish |
| **쏘카 FMS / 쏘카 비즈니스** | Koreya, korporativ avtomobil ulashish | Xodimlar bron qiladi, kalitlar boshqariladi, noto'g'ri foydalanish va noto'g'ri yoqilg'i quyish aniqlanadi |
| **롯데렌터카 오토매니저** | Koreya, korporativ avtomobil | Kompyuter va telefon orqali bron, yoqilg'i va yo'l to'lovlarini avtomatik yozish |
| **Fleetio** | Xorij, avtopark boshqaruvi | Motor Pool (bronni tasdiqlash), sozlanadigan dashboard, yoqilg'i jurnali |
| **RentHub / RENTALL / RentWorks** | Xorij, rent-a-car | Avtomobil sxemasida shikast belgilari, shikastlar tarixi, filiallar bo'yicha bo'sh avtomobillar |
| Samsara / Geotab | Xorij, monitoring | Real vaqtdagi GPS, bekor turish va haydash uslubi (faqat ma'lumot uchun) |
| Onfleet, 배민 va yetkazib berish agentliklari integratsiyasi | Yetkazib berish | Kuryerning real vaqtdagi joylashuvi, avtomatik buyurtma taqsimlash (bu safar qamrovdan tashqarida) |

---

## 2. Rent-a-car: xizmatlar tahlili

### RentDesk (휴비넷): Koreyadagi bevosita raqobatchi

![](03_rentdesk_main.jpg)
![](04_rentdesk_mobile.jpg)

Manba: <https://rentdesk.co.kr/erp.php> · Narx: 50 tagacha avtomobil uchun oyiga 50 000 von

| Funksiya | Bizda | Qaror |
|---|---|---|
| Xarita va avtomobillar ro'yxati bitta ekranda (rasmda: chapda menyu, tepada qidiruv, o'rtada xarita, pastda ro'yxat) | Xarita va boshqaruv ajralgan | **Olamiz.** "Holat" sahifasiga kichik xarita qo'shamiz. |
| Telefonda avtomobil tashqi ko'rinishini tekshirish (avtomobil sxemasida shikastni belgilash) | QR havola orqali faqat rasm yuklash | **Olamiz.** Sxemada shikast belgisi qo'shamiz. |
| Onlayn ijara shartnomasi, keyin elektron imzo, keyin SMS orqali yuborish | Faqat hisob-fakturani yuklab olish | **Olamiz (2-bosqich).** Topshirish havolasiga imzo qo'shamiz. |
| Haydovchilik guvohnomasini avtomatik tekshirish | Yo'q | **Kechiktiramiz.** Tashqi API va narxini aniqlash kerak. |
| Dvigatelni masofadan o'chirish, eshik va signalni boshqarish | Yo'q | **Kerak emas.** Bizning qurilma (ESP32) buni qila olmaydi. |
| Ijtimoiy savdo saytlari (Coupang va boshqalar) chiptalari integratsiyasi, kupon va ballar | Yo'q | **Kerak emas.** Mijozlarimiz kichik kompaniyalar, bu qamrovdan tashqarida. |
| Sarf materiallarini almashtirish muddati haqida ogohlantirish (motor moyi, shinalar) | Faqat texnik xizmat, sug'urta va ko'rik sanasi | **Olamiz.** Sana bilan birga probeg (km) bo'yicha ham. |
| Bandlik darajasi va daromad statistikasi | Yo'q | **Olamiz.** Bandlik darajasini GPS va shartnoma ma'lumotlaridan hisoblash mumkin. |

### RentHub / RENTALL / RentWorks: xorijiy rent-a-car

Manba: [RentHub funksiyalari](https://www.renthubsoftware.com/en/car-rental-software-and-cloud-management/vehicle-fleet-management-car-rental-software-features/) · [RENTALL](https://capterra.com/p/119277/RENTALL/) · [RentWorks Plus](https://www.getapp.co.uk/software/2141629/rentworks-plus)

- **Planning (Gantt ko'rinishidagi taqsimot jadvali).**
  - Qanday ishlaydi: har bir avtomobil bitta qator, har bir sana bitta ustun, har bir shartnoma esa chiziq bo'lib ko'rinadi. Bo'sh avtomobillar va ustma-ust tushgan shartnomalar bir qarashda ko'rinadi.
  - Qaror: **olamiz**. Rent-a-car ishiga hozirgi oylik kalendardan ko'ra mosroq.
- **Shikastlar tarixi.**
  - Qanday ishlaydi: har bir avtomobil uchun shikast rasmlari vaqt bo'yicha yig'iladi. Qaytarishda ular topshirilgan paytdagi rasmlar bilan solishtiriladi.
  - Qaror: **olamiz**. Topshirish va qaytarish rasmlari bizda allaqachon bor, ularni avtomobil sahifasida bir joyga yig'ib ko'rsatish kifoya.
- **Masofa va sana bo'yicha muddat ogohlantirishlari.**
  - Qanday ishlaydi: texnik xizmat muddati nafaqat sana, balki km bo'yicha ham kuzatiladi.
  - Qaror: **olamiz**.
- **Topshirish va qaytarish bitta ekranda.**
  - Qanday ishlaydi: qaytarishni bitta dialog oynasida rasmiylashtirish.
  - Qaror: hozirgi tuzilmani saqlaymiz, faqat bosqichlarni kamaytiramiz.
- **Filiallar bo'yicha bo'sh avtomobillar, broker va marketpleys integratsiyasi.**
  - Qaror: **kerak emas**. Mijozlarimiz bitta filialli kichik kompaniyalar.

---

## 3. Korporativ avtomobil: xizmatlar tahlili

### Fleetio: Motor Pool va Dashboard

![](01_fleetio_motor_pool.jpg)
![](02_fleetio_dashboard.jpg)

Manba: [Motor Pool](https://www.fleetio.com/features/motor-pool) · [Dashboards](https://www.fleetio.com/features/fleet-management-dashboards)

| Funksiya | Bizda | Qaror |
|---|---|---|
| Xodim avtomobil bronini so'raydi, admin tasdiqlaydi yoki rad etadi. Shartlar mos kelsa, **avtomatik tasdiqlanadi**. | Bronni faqat admin o'zi kiritadi | **Olamiz.** Xodimlar uchun so'rov havolasi va tasdiqlash navbati. |
| Bron tarixi, foydalanish vaqti va xarajat bo'yicha avtomobillardan foydalanish hisoboti | Faqat oylik masofa yig'indisi | **Olamiz.** Har bir avtomobil uchun foydalanish darajasi (%). |
| Dashboard vidjetlari: umumiy xarajat grafigi, hal qilinmagan muammolar (ochiq va muddati o'tgan), avtomobil holatlari taqsimoti | 4 ta raqamli karta | **Olamiz.** Avtomobil holatlari taqsimoti va xarajat dinamikasi. |
| Dashboard'ni televizorda to'liq ekranda ko'rsatish, vidjetlarni erkin joylashtirish | Yo'q | **Kerak emas.** Kichik mijozlar uchun ortiqcha. |
| Ta'mirlash buyurtmalari (work order), ehtiyot qismlar ombori | Yo'q | **Kerak emas.** |

### SK렌터카 스마트링크 · 쏘카 FMS · 롯데 오토매니저: Koreyadagi korporativ avtomobil xizmatlari

Manba: [스마트링크 ilovasi](https://apps.apple.com/us/app/%EC%8A%A4%EB%A7%88%ED%8A%B8%EB%A7%81%ED%81%AC-%ED%86%B5%ED%95%A9/id1661603946?l=ko) · [쏘카 FMS haqida maqola](https://www.fnnews.com/news/202403130916131440) · [LG U+ yurish jurnali qo'llanmasi](https://www.lguplus.com/biz/insight/story/735) · [SK렌터카 korporativ mijozlar so'rovi haqida maqola](https://www.heraldk.com/article/2026090318410442814)

- **Hammasida asosiy funksiya: yurish jurnalini soliq qo'mitasi shaklida avtomatik yozish.**
  - SK렌터카 465 ta kompaniya o'rtasida so'rov o'tkazgan. Unga ko'ra korporativ mijozlar endi "narx"dan ko'ra "ish yukini kamaytirish"ga qarab tanlashmoqda.
  - Bizda bu funksiya allaqachon bor. Uni **birinchi ekranga olib chiqamiz**: "Bu oy yurish jurnalining n% to'ldirilgan" yozuvi va darhol chop etish tugmasi.
- **Yoqilg'i va Hi-pass xarajatlarini birlashtirish** (스마트링크, 쏘카 va 오토매니저 hammasida bor).
  - Bizda har bir yurish uchun yoqilg'i kiritiladi.
  - **Olamiz:** oylik yoqilg'i xarajati yig'indisi kartasi va chek rasmini biriktirish.
  - Hi-pass karta integratsiyasini **kechiktiramiz**, chunki tashqi integratsiya kerak.
- **Noto'g'ri foydalanishni aniqlash** (쏘카: ish vaqtidan tashqari yurish, noto'g'ri yoqilg'i quyish).
  - **Olamiz:** bron qilinmagan vaqtda yoki ish vaqtidan tashqarida yurilganda ogohlantirish. Buni faqat GPS ma'lumotlari bilan qilish mumkin.
- **Ish va ishdan tashqari vaqtni sozlash** (휴맥스 FMS).
  - **Olamiz:** "Sozlamalar" bo'limida ish vaqtini kiritish. Yuqoridagi ogohlantirish shunga tayanadi.
- **Kalitsiz kirish (smart kalit), zaxira avtomobil bilan bog'lanish** (쏘카).
  - **Kerak emas.** Buning uchun maxsus qurilma va hamkorlik kerak.

---

## 4. Ish yo'nalishi (taklif)

### Rent-a-car

| Ustuvorlik | Vazifa | Asos |
|---|---|---|
| P1 | **"Holat" sahifasiga kichik xarita.** Ijaradagi, bo'sh va qaytarishi kechikkan avtomobillar turli rangda. | RentDesk |
| P1 | "Qaytarish jadvali"ga **taqsimot jadvali (Gantt)** ko'rinishini qo'shish (oylik kalendar bilan almashtirib ko'riladi) | RentHub Planning |
| P1 | **Ulanish muammosi va shartnoma holati bo'yicha ogohlantirish.** Ijaradagi avtomobil n soatdan ortiq oflayn bo'lsa, vazifalar ro'yxatining tepasiga chiqadi. | Bizning kuchli tomonimiz (GPS) |
| P2 | Avtomobil sahifasida **shikast rasmlari tarixi** (topshirish va qaytarish rasmlari to'plami) | RentHub, RENTALL |
| P2 | Topshirish havolasiga **sxemada shikast belgisi va elektron imzo** | RentDesk, RentHQ |
| P2 | **Bandlik darajasi hisoboti:** har bir avtomobilning ijaradagi kunlari umumiy kunlarga nisbatan, oylik daromad | RentDesk statistikasi |
| P3 | Sarf materiallari ogohlantirishiga **km bo'yicha** variant qo'shish | RentDesk, RentHub |

### Korporativ avtomobil

| Ustuvorlik | Vazifa | Asos |
|---|---|---|
| P1 | **Birinchi ekranni qayta tuzish.** Ikkita bo'sh blok o'rniga: ① kichik xarita ② bu oy yurish jurnalining to'ldirilish darajasi va chop etish tugmasi ③ oxirgi 5 ta yurish | 스마트링크 va 쏘카'da umumiy |
| P1 | Bo'sh holatni **bir qatorga qisqartirish** (bron 0 ta bo'lsa, blok balandligi kichik bo'ladi) | Hozirgi 1-muammo |
| P1 | **Oylik yoqilg'i xarajati kartasi** (har bir yurishda kiritilgan qiymatlar yig'indisi) | 스마트링크, 오토매니저 |
| P2 | **Xodim bron so'raydi, admin tasdiqlaydi** (va avtomatik tasdiqlash shartlari) | Fleetio Motor Pool |
| P2 | **Ish vaqtini sozlash va ish vaqtidan tashqari yurish haqida ogohlantirish** | 쏘카, 휴맥스 FMS |
| P2 | **Har bir avtomobilning foydalanish darajasi** hisoboti | Fleetio |
| P3 | Yoqilg'i uchun chek rasmini biriktirish | 오토매니저 |

### Qilinmaydiganlar

- **Dvigatelni o'chirish, eshikni masofadan boshqarish, smart kalit.** Qurilmamiz buni qila olmaydi.
- **Ijtimoiy savdo saytlari integratsiyasi, kupon va ballar.** Mijozlarimiz (kichik kompaniyalar) uchun mos emas.
- **Dashboard vidjetlarini erkin joylashtirish, televizor rejimi.** Ortiqcha.
- **Ta'mirlash buyurtmalari va ehtiyot qismlar ombori.** Qamrovdan tashqarida.
- **Hi-pass karta va haydovchilik guvohnomasini tekshirish API'si.** Narx va hamkorlik aniqlangach, qayta ko'rib chiqamiz.

---

## 5. Ma'lumot uchun: yetkazib berish (bu safar qamrovdan tashqarida)

- 배민 (Baemin) 6 ta yirik yetkazib berish agentligi bilan kuryer joylashuvini bog'lagan (2026-07). Yetkazib berish sohasida "kuryerning real vaqtdagi joylashuvi va buyurtma holati" endi oddiy talabga aylangan. [Maqola](https://v.daum.net/v/20260727162246267)
- Onfleet'da avtomatik taqsimlash bor. Haydovchi joylashuvi va yetib kelish vaqti (ETA) bitta ekranda ko'rinadi. Yetkazib berilganini tasdiqlash uchun rasm va imzo olinadi. [Havola](https://onfleet.com/assignment-and-dispatching)
- Hozirgi `DeliveryPanel.jsx` (172 qator) oddiy darajada. Korporativ avtomobil va rent-a-car tayyor bo'lgach ko'rib chiqiladi.

---

## 6. Ikkinchi fikr asosida (menyu · mobil · ajralib turish · mototsikl)

Maketlar sahifasi: [proposal.html](proposal.html) (kompyuter va telefon maketlari, koreyscha/o'zbekcha)

### 6-1. Menyu bitta qavat (fikr: chap menyu qismi noqulay)

![](00_ours_nav_issue.png)

- **Hozir:** umumiy menyu 64px, ish menyusi 172px, sarlavha va izoh taxminan 93px. Bir xil vazifadagi menyu ikki joyda.
- **Taklif:** ish menyusi sarlavhadagi tablarga ko'chiriladi. Natijada:
  - ekran kengligi +172px (+16%);
  - sarlavha balandligi 93 → 60px;
  - tanlash bosqichi 2 → 1.
- **Izoh matni o'rniga:** "출고부터 반납까지…" o'rniga real vaqt holati bitta qatorda ko'rsatiladi.
- **Qidiruv:** sarlavhaga qidiruv (Ctrl K) qo'shiladi, mavjud CommandPalette qayta ishlatiladi.
- **Mobil:** biznes akkauntda pastki tabning o'zi ish menyusi bo'ladi (Holat · Taqsimot · + · Xarita · Yana). Hozir ikki qavat: pastki tab (BottomNav.jsx) → "렌트" → yana tepadagi tablar.

### 6-2. Mobil birinchi o'rinda

- **Pastki tab:** markazida katta tugma bor (yangi shartnoma yoki bron).
- **Surish:** ro'yxatdagi ishni surib bajarish.
- **Bosqichlar pastki panelda.** Masalan, qaytarish 4 bosqich: tekshirish → masofa va yoqilg'i → rasm → hisob-kitob.
- **Xarita:** to'liq ekranda, ro'yxat pastdan yuqoriga tortiladi.
- **Bosish maydoni** kamida 44px. Asosiy tugmalar bosh barmoq yetadigan pastki qismda.

### 6-3. Ajralib turish: GPS avtomatik aniqlash + bir bosish

"Yozuvni avtomobil qiladi, odam faqat tasdiqlaydi." GPS aniqlagan fakt darhol vazifa va xabarnomaga aylanadi, odam bir marta tasdiqlaydi.

| Tur | Aniqlash | Avtomatik bajariladi | Odam |
|---|---|---|---|
| Rent-a-car | Turargoh geozonasiga kirish | GPS masofasi bo'yicha ortiqcha km hisobi, rasm havolasi yuboriladi | [Hisobni tasdiqlash] |
| Korporativ | Yurish tugashi | Yurish qatorlarga bo'linadi, haydovchidan maqsad so'raladi | Oy oxirida [soliq shaklini chop etish] |
| Yetkazish | To'xtash rejimida harakat | Yo'l saqlanadi, shoshilinch xabar | [Joylashuvni ulashish] |

- **Bizda bor (kodda tekshirildi):**
  - geozona;
  - yurishni avtomatik bo'lish (corporate trips);
  - signal uzilishi ogohlantirishi (connection_alert_episodes);
  - tezlik, keskin tezlanish va tungi harakatni aniqlash (ai.rs);
  - topshirish havolasi va joylashuv havolasi;
  - Kakao alimtalk va FCM push.
- **Yangi qilinadigan:**
  - qoidalar ekrani;
  - aniqlash → vazifa ulanishi;
  - xabar ichidagi tugmalar;
  - ertalabki brifing.

### 6-4. Yetkazib berish · mototsikl benchmarki

| Xizmat | Xususiyati | Qaror |
|---|---|---|
| **에이링크** (SK렌터카 × 에이렌탈앤서비스, 2025-yil avgust) | 스마트링크 asosidagi mototsikl monitoringi: GPS joylashuv, yurish tarixi, anomaliyani aniqlash. 에이렌탈 배민, 쿠팡이츠 kabi yetkazib berish sohasiga mototsikl ijaraga beradi | Koreyadagi bevosita raqobatchi. Joylashuv va yozuvlar bizda ham bor → **anomaliyani qoidaga aylantiramiz** |
| **Wunder Mobility** | "Bandlik = daromad". Holat rangidagi xarita (bo'sh / zaryadda / tekshiruvda / oflayn). Muammo → ustuvor vazifa → joydagi xodim | **Olamiz:** holat rangidagi xarita, muammoni vazifaga aylantirish |
| **Fleeti** (ikki g'ildirakli yetkazish) | Ish vaqtidan tashqari harakatni aniqlash, xavfsiz hududdan chiqish ogohlantirishi, yetkazib berish isboti | **Olamiz:** hududdan chiqish va ish vaqtidan tashqari harakat. Yetkazish isboti keyinga qoladi |
| **Monimoto** | Mototsiklni o'g'irlikdan himoya qiluvchi tracker. Qo'riqlash rejimida harakat bo'lsa 1 daqiqada qo'ng'iroq qiladi | **Olamiz:** to'xtash rejimi + shoshilinch xabar |
| **ZyppDash** (Hindiston, elektr skuterlar) | Kuryer va transportning real vaqtdagi joylashuvi, smenadagi kuryerlarni boshqarish | Ma'lumot uchun |

![](05_wunder_operations.jpg)
![](06_monimoto.jpg)

**Taklif:**
- do'kon radiusi bo'yicha hudud xaritasi;
- "hozir tekshiriladigan ishlar" ro'yxati: tezlik oshishi, hududdan chiqish, telefon signali yo'qligi;
- to'xtash rejimida o'g'irlikni aniqlash;
- kuryer xavfsizlik bahosi. Mavjud AI tahlilidagi tezlik, keskin tezlanish va tungi harakat aniqlash qayta ishlatiladi;
- telefon ilovasi (mavjud phone qurilma) bilan ham boshlash imkoniyati.

Manbalar: [에이링크 maqolasi](https://www.sidae.com/article/2025080708515382872) · [Wunder Operations](https://www.wundermobility.com/en/platform/operations) · [Fleeti ikki g'ildirakli](https://en.fleeti.co/secteurs/coursiers-2-roues) · [Monimoto](https://monimoto.com) · [ZyppDash maqolasi](https://autocarpro.in/news/zypp-electric-launches-zyppdash-fleet-management-dashboard-113943)

---

## Skrinshotlar haqida izoh

- Skrinshotlar xizmatlarning ochiq reklama sahifalaridan olingan, login ichidagi ekranlar emas. Haqiqiy admin ekranini ko'rish uchun demo so'rash kerak.
- 스마트링크 va 쏘카 FMS'ning admin ekrani rasmlari ochiq joyda yo'q. Shuning uchun ular faqat funksiyalar tavsifi bilan berilgan.
- Samsara sahifasi asosan videodan iborat, shuning uchun skrinshotlarga kiritilmadi.
