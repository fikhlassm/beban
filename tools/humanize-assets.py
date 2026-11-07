"""Generate per-account caption & image variants for human-like posting.

Usage:
  python tools/humanize-assets.py            # apply (backup + generate)
  python tools/humanize-assets.py --dry-run  # show plan without writing
  python tools/humanize-assets.py --report   # show current hashes only

Idempotent: backups are used as source when present, so re-running regenerates
variants from originals instead of compounding edits.
"""
from __future__ import annotations

import hashlib
import io
import json
import random
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parents[1]
ACCOUNTS_DIR = ROOT / "accounts"
ACCOUNT_IDS = [f"fb{i:02d}" for i in range(1, 15)]

# Curated phrase bank. Safe transformations only: no new claims, no prices.
PREFIXES = [
    "",
    "Ready stock! ",
    "Satset ya, ",
    "Murah banget, ",
    "Cek dulu, ",
    "Barangkali masih ada, ",
    "Jangan lewatkan, ",
]

SUFFIXES = [
    "",
    " Minat? Chat ya.",
    " Buruan sebelum habis.",
    " Cek sekarang.",
    " Yang butuh, gaskeun.",
    " Link di bawah.",
]

SYNONYMS = {
    "murah banget": ["harga miring", "murah parah", "murah bgt"],
    "murah bgt": ["murah parah", "harga miring", "murah banget"],
    "siapa tau": ["barangkali", "mungkin", "siapa tahu"],
    "mana tau": ["barangkali", "siapa tau", "mungkin"],
    "kalo masih": ["kalau masih", "jika masih", "kalo masih ada"],
    "under": ["di bawah", "kisaran"],
}

MAX_CAPTION_CHARS = 300
URL_RE = r"https?://\S+"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def extract_url(text: str) -> str | None:
    import re

    m = re.search(URL_RE, text)
    return m.group(0).strip() if m else None


def apply_synonyms(text: str, rng: random.Random) -> str:
    lower = text.lower()
    for source, targets in SYNONYMS.items():
        if source in lower:
            replacement = rng.choice(targets)
            if replacement.lower() == source:
                continue
            # Replace case-insensitively, preserve length sanity.
            import re

            text = re.sub(re.escape(source), replacement, text, flags=re.IGNORECASE)
            lower = text.lower()
    return text


def generate_caption_variant(base: str, rng: random.Random) -> str:
    """Return caption with URL preserved, no emoji, no new claims."""
    url = extract_url(base)
    if not url:
        return base

    caption = base.replace(url, "").strip()
    caption = apply_synonyms(caption, rng)

    prefix = rng.choice(PREFIXES)
    suffix = rng.choice(SUFFIXES)
    candidate = f"{prefix}{caption}{suffix}".strip()

    # Layout variations: newline before URL or same line.
    layouts = [
        f"{candidate}\n{url}",
        f"{candidate} {url}",
        f"{candidate}\n\n{url}",
    ]
    out = rng.choice(layouts)

    if len(out) > MAX_CAPTION_CHARS:
        # Fallback: minimal variation.
        out = f"{caption}\n{url}"
    return out


def unique_caption_for_account(
    account_id: str, base: str, used: set[str]
) -> str:
    """Pick a stable base variant per account from the phrase bank."""
    for attempt in range(60):
        seed = f"{account_id}:{attempt}"
        rng = random.Random(seed)
        variant = generate_caption_variant(base, rng)
        if variant not in used:
            used.add(variant)
            return variant
    # Fall back to original with account marker (should not happen).
    return base


def process_caption(
    account_dir: Path, batch: str, dry_run: bool, used: set[str]
) -> tuple[str, str, str]:
    """Returns (original_hash, new_hash, variant_text)."""
    text_path = account_dir / "content" / batch / "text.txt"
    backup_path = account_dir / "content" / batch / "text-original.txt"

    if backup_path.exists():
        original = backup_path.read_text(encoding="utf-8")
    else:
        original = text_path.read_text(encoding="utf-8")
        if not dry_run:
            shutil.copy2(text_path, backup_path)

    url = extract_url(original)
    if not url:
        return (sha256(original.encode()), sha256(original.encode()), original)

    variant = unique_caption_for_account(account_dir.name, original, used)
    new_bytes = variant.encode("utf-8")
    if not dry_run:
        text_path.write_text(variant, encoding="utf-8", newline="\n")
    return (sha256(original.encode()), sha256(new_bytes), variant)


def process_images(
    account_dir: Path, batch: str, dry_run: bool
) -> list[tuple[str, str]]:
    """Return list of (original_hash, new_hash) for each image."""
    images_dir = account_dir / "content" / batch / "images"
    backup_dir = account_dir / "content" / batch / "images-original"
    if not images_dir.exists():
        return []

    # Backup originals once.
    if not dry_run:
        backup_dir.mkdir(parents=True, exist_ok=True)
        for f in images_dir.iterdir():
            if f.is_file():
                b = backup_dir / f.name
                if not b.exists():
                    shutil.copy2(f, b)

    source_dir = backup_dir if backup_dir.exists() else images_dir
    results: list[tuple[str, str]] = []
    seed = f"{account_dir.name}:{batch}"
    rng = random.Random(seed)

    for f in sorted(source_dir.iterdir()):
        if not f.is_file():
            continue
        original_bytes = f.read_bytes()
        orig_hash = sha256(original_bytes)

        try:
            img = Image.open(io.BytesIO(original_bytes))
            img = img.convert("RGB")
        except Exception as e:
            print(f"  skip {f.name}: {e}")
            results.append((orig_hash, orig_hash))
            continue

        # Crop 1-2% from each side.
        w, h = img.size
        frac = rng.uniform(0.01, 0.02)
        crop_w = int(w * (1 - 2 * frac))
        crop_h = int(h * (1 - 2 * frac))
        left = rng.randint(0, w - crop_w)
        top = rng.randint(0, h - crop_h)
        img = img.crop((left, top, left + crop_w, top + crop_h))

        # Restore to original size for consistent upload dimensions.
        img = img.resize((w, h), Image.LANCZOS)

        # Brightness / contrast jitter.
        img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.97, 1.03))
        img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.97, 1.03))

        # Re-encode JPEG, strip EXIF (PIL drops it when re-saving).
        buf = io.BytesIO()
        quality = rng.randint(86, 93)
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        new_bytes = buf.getvalue()
        new_hash = sha256(new_bytes)

        if not dry_run:
            target = images_dir / f.name
            target.write_bytes(new_bytes)
        results.append((orig_hash, new_hash))
    return results


def main() -> None:
    args = set(sys.argv[1:])
    dry_run = "--dry-run" in args
    report_only = "--report" in args

    used_captions: set[str] = set()
    problems: list[str] = []

    for account_id in ACCOUNT_IDS:
        account_dir = ACCOUNTS_DIR / account_id
        content_dir = account_dir / "content"
        if not content_dir.exists():
            continue
        batches = sorted(
            [d.name for d in content_dir.iterdir() if d.is_dir() and d.name.isdigit()],
            key=int,
        )
        for batch in batches:
            if report_only:
                text_path = content_dir / batch / "text.txt"
                if text_path.exists():
                    data = text_path.read_bytes()
                    print(f"{account_id} B{batch} text {sha256(data)}")
                for img in sorted((content_dir / batch / "images").glob("*")):
                    if img.is_file():
                        print(f"{account_id} B{batch} img  {sha256(img.read_bytes())}")
                continue

            print(f"=== {account_id} batch {batch} ===")
            orig_h, new_h, variant = process_caption(
                account_dir, batch, dry_run, used_captions
            )
            print(f"  text: {orig_h} -> {new_h}")
            print(f"  caption: {variant!r}")
            if orig_h == new_h:
                problems.append(f"{account_id} B{batch}: caption hash unchanged")

            img_results = process_images(account_dir, batch, dry_run)
            for i, (oh, nh) in enumerate(img_results):
                print(f"  img{i}: {oh} -> {nh}")
                if oh == nh:
                    problems.append(f"{account_id} B{batch} img{i}: hash unchanged")

    if report_only:
        return

    if dry_run:
        print("\n[dry-run] no files written")
    else:
        print("\n[done] variants written")

    if problems:
        print("\nPROBLEMS:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)


if __name__ == "__main__":
    main()
