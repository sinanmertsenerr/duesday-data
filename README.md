# duesday-data

Duesday'in katalog verisi + Price Radar fiyat hattı (M5).
Uygulama reposu: `duesday-app` (Flutter). Bu repo **veri ve otomasyondur**;
Cloudflare Pages üzerinden statik CDN olarak yayınlanır.

## Dosyalar

| Dosya | Ne | Kim okur |
|---|---|---|
| `catalog.json` | Servis kataloğu (schemaVersion 1, para = int minör birim) | App (CDN'den, ETag/304) |
| `history.json` | Fiyat geçmişi — git log'dan otomatik üretilir, elle DÜZENLENMEZ | App (ileride, Radar grafiği) |
| `changes/latest.json` | Son fiyat değişiklik listesi (M6 FCM push kancası) | M6 workflow'u |
| `scraper/` | Node 22 scraper — fetch → JSON-LD/CSS parse → diff → sanity → PR | GitHub Actions |

## Fiyat hattı nasıl çalışır

1. **Cron** (her gün 04:00 UTC) `price-scrape` workflow'u koşar.
2. Config'teki servis-bölgeler **sırayla** (15 sn arayla, kimliği açık bot UA ile) çekilir.
   Bir servisin kırılması diğerlerini etkilemez — hata rapora düşer.
3. **Diff + sanity**: 4x üstü artış / %60 üstü düşüş / kur değişimi / bilinmeyen id
   → **karantina** (otomatik uygulanmaz). Başarılı örneklerin >%50'si aynı anda
   değiştiyse **koşu anomalisi** → PR hiç açılmaz, issue açılır.
4. Temiz değişiklikler `catalog.json`'a uygulanır, üretilen dosya app-parser
   kurallarıyla **yerel doğrulanır** (geçmezse PR yok, workflow kırmızı).
5. `automated/price-updates` branch'ine **idempotent PR** açılır/güncellenir —
   gövdede kaynak link + eski→yeni + %değişim tablosu. **İnsan merge eder.**
6. Merge → Cloudflare Pages otomatik deploy → app ETag değişimini görür.
   `history` workflow'u `history.json`'u git log'dan yeniden üretip commit'ler.

## Değişmez kurallar (app sözleşmesi)

- `schemaVersion` **1 sabit** — artırmak tüm eski app'leri gömülü kataloğa düşürür.
- Scraper **id üretmez, silmez** — yeni servis/bölge insan kararıdır.
- `minorUnits` her zaman **pozitif int** (float yasak), `currency` bölgeyle tutarlı
  ISO 4217 (`tr→TRY`, `us→USD`).
- No-op koşuda dosyaya dokunulmaz (gereksiz ETag değişimi app'e boşuna
  tam indirme yaptırır).

## Kurulum (bir kez, ~5 dk)

1. **GitHub'a push:**
   ```bash
   gh repo create duesday-data --public --source . --push
   # veya: GitHub'da boş repo aç → git remote add origin ... → git push -u origin main
   ```
2. **Cloudflare Pages bağla:** Cloudflare Dashboard → Workers & Pages →
   Create → Pages → Connect to Git → `duesday-data` seç.
   Build command: **boş** · Output directory: **/** (kök). Save & Deploy.
3. **Custom domain:** Pages projesi → Custom domains →
   `duesday.sinansener.com` ekle (DNS Cloudflare'deyse tek tık).
   Doğrula: `curl -I https://duesday.sinansener.com/catalog.json` → 200 + ETag.

Repo ayarı: Settings → Actions → General → "Allow GitHub Actions to create and
approve pull requests" **açık** olmalı (otomatik PR için).

## Geliştirme

```bash
npm ci          # tek bağımlılık: cheerio
npm test        # node:test — fixture'lı parser/diff/history testleri
npm run scrape  # gerçek tarama (lokal deneme)
npm run simulate # sahte fiyat değişikliği enjekte et (uçtan uca prova)
npm run validate # catalog.json şema kontrolü
```

Yeni servis eklemek: `scraper/services.config.json`'a blok ekle (id
`catalog.json`'da zaten var olmalı), fiyat sayfasının robots.txt'ini elle
kontrol edip `robotsCheckedAt` alanına tarihi yaz, mümkünse sayfanın
kaydedilmiş HTML'ini `test/fixtures/`'a koyup selector testi ekle.

Politeness: kimliği açık UA (`Duesday-PriceBot/1.0`), istek arası 15 sn,
günde tek koşu, yalnız herkese açık fiyat sayfaları.
