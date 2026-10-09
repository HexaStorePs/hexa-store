# موقع HEXA STORE: إزاي تشغّله

الموقع صفحة واحدة (`index.html`) بتقرا ملف `data/games.json`، والملف ده بيتحدّث لوحده كل 30 دقيقة من Notion ومتجر بلايستيشن.

## اللي في الفولدر
| الملف | بيعمل إيه |
|---|---|
| `index.html` | صفحة الموقع نفسها |
| `site.config.json` | **هنا بتحط روابط التواصل** (ماسنجر، واتساب، انستجرام) |
| `data/games.json` | الألعاب والأسعار (بيتولّد لوحده) |
| `scripts/build-data.mjs` | بيسحب من Notion ومتجر بلايستيشن ويكتب `games.json` |
| `.github/workflows/update-data.yml` | بيشغّل السكريبت كل 30 دقيقة |

## الخطوة 1: روابط التواصل
افتح `site.config.json` وغيّر:
- `facebookMessenger`: `https://m.me/اسم-صفحتك` (اسم الصفحة اللي في رابطها)
- `whatsapp`: رقمك بالصيغة الدولية من غير + ومن غير صفر: `201012345678`
- `instagram`: `https://ig.me/m/اسم-حسابك`

## الخطوة 2: التشغيل على الإنترنت (مجانًا، GitHub Pages)
1. اعمل حساب على github.com (لو مفيش).
2. اعمل Repository جديد اسمه مثلًا `hexa-store` (Public).
3. ارفع كل ملفات الفولدر ده فيه.
4. من Settings ← Pages: اختار Branch `main` وفولدر `/ (root)` ← Save. هيدّيك رابط الموقع.
5. من Settings ← Secrets and variables ← Actions ← New repository secret:
   - الاسم: `NOTION_TOKEN`
   - القيمة: توكن Notion Integration (يفضّل Integration مخصوصة بتقرا بس، ومشاركة معاها جدولي Prices (PS) وPS ALL GAMES).
6. من تاب Actions ← Update games data ← Run workflow (مرة واحدة تبدأ بيها)، وبعدها بيشتغل لوحده كل 30 دقيقة.

## ملاحظات
- **سعر الفل أكونت مش بيظهر** في الموقع خالص، ولا بيتكتب في `games.json`.
- التوكن بيتخزّن في Secrets بتاعة GitHub بس، مش في الموقع.
- لو عايز دومين خاص (hexastore.hair مثلًا): Settings ← Pages ← Custom domain.
- لتجربة السكريبت على جهازك: `NOTION_TOKEN=xxxx node scripts/build-data.mjs` (محتاج Node 18+).
