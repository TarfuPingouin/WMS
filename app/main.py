# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 les contributeurs du projet
"""Inventaire d'atelier : API, base SQLite, photos, historique, projets, sauvegardes, CSV."""
import csv
import io
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import unicodedata
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

DATA_DIR = os.environ.get("WMS_DATA", "/data")
PHOTO_DIR = os.path.join(DATA_DIR, "photos")
DB_PATH = os.path.join(DATA_DIR, "inventaire.db")
BACKUP_DIR = os.environ.get("WMS_BACKUPS", "/backups")
BACKUP_KEEP = 10
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
LEVELS = ["Vide", "Peu", "Correct", "Beaucoup"]
SEP = " › "
DEFAULT_NAME = "Mon atelier"
try:
    with open(os.path.join(os.path.dirname(__file__), "VERSION"), encoding="utf-8") as _f:
        VERSION = _f.read().strip()
except OSError:
    VERSION = "inconnue"

os.makedirs(PHOTO_DIR, exist_ok=True)

SCHEMA = """
CREATE TABLE IF NOT EXISTS locations (
    id          INTEGER PRIMARY KEY,
    parent_id   INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
    name        TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    photo       TEXT,
    verified_at TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    location_id INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
    qty_mode    TEXT NOT NULL DEFAULT 'exact' CHECK (qty_mode IN ('exact', 'approx')),
    qty         INTEGER NOT NULL DEFAULT 0,
    level       INTEGER NOT NULL DEFAULT 2 CHECK (level BETWEEN 0 AND 3),
    wanted      INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    photo       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS item_tags (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (item_id, tag)
);
CREATE TABLE IF NOT EXISTS history (
    id      INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    at      TEXT NOT NULL,
    kind    TEXT NOT NULL,
    old     TEXT,
    new     TEXT,
    n       INTEGER,
    ref     TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'done')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at    TEXT
);
CREATE TABLE IF NOT EXISTS project_lines (
    id         INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    item_id    INTEGER REFERENCES items(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    qty        INTEGER NOT NULL DEFAULT 1,
    position   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_takes (
    id         INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    item_id    INTEGER REFERENCES items(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL DEFAULT '',
    qty        INTEGER,
    level_from TEXT,
    level_to   TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_location ON items(location_id);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id);
CREATE INDEX IF NOT EXISTS idx_history_item ON history(item_id, at);
"""

# Colonnes ajoutées après la première version (migration automatique)
NEW_ITEM_COLUMNS = {
    "low_at": "INTEGER",
    "buy_url": "TEXT NOT NULL DEFAULT ''",
    "price": "REAL",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


with connect() as _con:
    _con.execute("PRAGMA journal_mode = WAL")
    _con.executescript(SCHEMA)
    existing = {r["name"] for r in _con.execute("PRAGMA table_info(items)")}
    for col, decl in NEW_ITEM_COLUMNS.items():
        if col not in existing:
            _con.execute(f"ALTER TABLE items ADD COLUMN {col} {decl}")
    if "ref" not in {r["name"] for r in _con.execute("PRAGMA table_info(history)")}:
        _con.execute("ALTER TABLE history ADD COLUMN ref TEXT")


# ---------- Modèles ----------

class LocationIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    parent_id: Optional[int] = None
    note: Optional[str] = Field(None, max_length=5000)
    verified: Optional[bool] = None


class ItemIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    location_id: Optional[int] = None
    qty_mode: Optional[str] = Field(None, pattern="^(exact|approx)$")
    qty: Optional[int] = Field(None, ge=0, le=10_000_000)
    level: Optional[int] = Field(None, ge=0, le=3)
    low_at: Optional[int] = Field(None, ge=0, le=10_000_000)
    wanted: Optional[bool] = None
    note: Optional[str] = Field(None, max_length=5000)
    buy_url: Optional[str] = Field(None, max_length=2000)
    price: Optional[float] = Field(None, ge=0, le=10_000_000)
    tags: Optional[list[str]] = None
    event: Optional[str] = Field(None, pattern="^(buy|missing)$")


class MoveIn(BaseModel):
    location_id: int
    qty: Optional[int] = Field(None, ge=1, le=10_000_000)


class SettingsIn(BaseModel):
    name: Optional[str] = Field(None, max_length=60)


class ProjectIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    note: Optional[str] = Field(None, max_length=5000)


class LineIn(BaseModel):
    item_id: Optional[int] = None
    qty: Optional[int] = Field(None, ge=0, le=10_000_000)


class TakeIn(BaseModel):
    item_id: int
    qty: Optional[int] = Field(None, ge=0, le=10_000_000)
    level: Optional[int] = Field(None, ge=0, le=3)


class CheckoutIn(BaseModel):
    takes: list[TakeIn]


class TagRenameIn(BaseModel):
    old: str = Field(..., max_length=60)
    new: str = Field("", max_length=60)


# ---------- Utilitaires ----------

def clean_name(value: Optional[str]) -> str:
    name = (value or "").strip()
    if not name:
        raise HTTPException(400, "Le nom est obligatoire.")
    return name


def clean_tag(t: str) -> str:
    return " ".join(str(t).strip().lower().split())[:60]


def clean_tags(tags: list[str]) -> list[str]:
    seen, out = set(), []
    for t in tags:
        t = clean_tag(t)
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def clean_url(url: Optional[str]) -> str:
    url = (url or "").strip()
    if url and not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    return url


def location_row(con, loc_id: int) -> sqlite3.Row:
    row = con.execute("SELECT * FROM locations WHERE id = ?", (loc_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Cet emplacement n'existe plus.")
    return row


def item_row(con, item_id: int) -> sqlite3.Row:
    row = con.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Cet article n'existe plus.")
    return row


def item_dict(con, row: sqlite3.Row) -> dict:
    d = dict(row)
    d["wanted"] = bool(d["wanted"])
    d["tags"] = [r["tag"] for r in con.execute(
        "SELECT tag FROM item_tags WHERE item_id = ? ORDER BY tag", (d["id"],))]
    return d


def path_text(con, loc_id: Optional[int]) -> str:
    names, seen = [], set()
    while loc_id is not None and loc_id not in seen:
        seen.add(loc_id)
        row = con.execute("SELECT name, parent_id FROM locations WHERE id = ?", (loc_id,)).fetchone()
        if row is None:
            break
        names.insert(0, row["name"])
        loc_id = row["parent_id"]
    return SEP.join(names)


def check_parent(con, loc_id: Optional[int], parent_id: Optional[int]) -> None:
    """Empêche qu'un contenant soit rangé dans lui-même ou dans l'un de ses sous-contenants."""
    if parent_id is None:
        return
    location_row(con, parent_id)
    current = parent_id
    while current is not None:
        if current == loc_id:
            raise HTTPException(400, "Un contenant ne peut pas être rangé dans lui-même ou dans l'un de ses sous-contenants.")
        current = con.execute("SELECT parent_id FROM locations WHERE id = ?", (current,)).fetchone()["parent_id"]


def log(con, item_id: int, kind: str, old=None, new=None, n: Optional[int] = None, ref: Optional[str] = None) -> None:
    """Ajoute une ligne à l'historique. Les clics rapides sur la quantité sont regroupés (2 minutes)."""
    t = now()
    if kind in ("qty", "level"):
        last = con.execute("SELECT * FROM history WHERE item_id = ? ORDER BY id DESC LIMIT 1", (item_id,)).fetchone()
        limit = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat(timespec="seconds")
        if last is not None and last["kind"] == kind and last["at"] >= limit:
            if str(last["old"]) == str(new):
                con.execute("DELETE FROM history WHERE id = ?", (last["id"],))
            else:
                con.execute("UPDATE history SET new = ?, at = ? WHERE id = ?", (str(new), t, last["id"]))
            return
    con.execute("INSERT INTO history (item_id, at, kind, old, new, n, ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (item_id, t, kind, None if old is None else str(old), None if new is None else str(new), n, ref))


def save_photo(upload: UploadFile) -> str:
    try:
        img = Image.open(upload.file)
        img = ImageOps.exif_transpose(img).convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(400, "Ce fichier n'est pas une image lisible (formats acceptés : JPEG, PNG, WebP).")
    name = uuid.uuid4().hex
    big = img.copy()
    big.thumbnail((1600, 1600))
    big.save(os.path.join(PHOTO_DIR, f"{name}.jpg"), quality=85, optimize=True)
    ImageOps.fit(img, (320, 320)).save(os.path.join(PHOTO_DIR, f"{name}_t.jpg"), quality=80, optimize=True)
    return name


def copy_photo(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    new = uuid.uuid4().hex
    try:
        for suffix in ("", "_t"):
            shutil.copyfile(os.path.join(PHOTO_DIR, f"{name}{suffix}.jpg"), os.path.join(PHOTO_DIR, f"{new}{suffix}.jpg"))
    except FileNotFoundError:
        return None
    return new


def delete_photo(name: Optional[str]) -> None:
    if not name:
        return
    for suffix in ("", "_t"):
        try:
            os.remove(os.path.join(PHOTO_DIR, f"{name}{suffix}.jpg"))
        except FileNotFoundError:
            pass


# ---------- Sauvegardes ----------

def write_backup(dest: str) -> None:
    """Copie cohérente de la base (API de sauvegarde SQLite) et des photos dans une archive zip."""
    tmp_db = dest + ".db"
    src = connect()
    dst = sqlite3.connect(tmp_db)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    try:
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(tmp_db, "inventaire.db")
            for f in sorted(os.listdir(PHOTO_DIR)):
                z.write(os.path.join(PHOTO_DIR, f), f"photos/{f}", compress_type=zipfile.ZIP_STORED)
    finally:
        os.remove(tmp_db)


def backups_enabled() -> bool:
    return os.path.isdir(BACKUP_DIR) and os.access(BACKUP_DIR, os.W_OK)


def list_backups() -> list[str]:
    if not backups_enabled():
        return []
    return sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("inventaire-") and f.endswith(".zip"))


def daily_backup() -> None:
    name = f"inventaire-{datetime.now(timezone.utc).date().isoformat()}.zip"
    path = os.path.join(BACKUP_DIR, name)
    if os.path.exists(path):
        return
    write_backup(path + ".part")
    os.replace(path + ".part", path)
    for old in list_backups()[:-BACKUP_KEEP]:
        os.remove(os.path.join(BACKUP_DIR, old))


def backup_loop() -> None:
    while True:
        try:
            daily_backup()
        except Exception as e:  # la boucle ne doit jamais s'arrêter
            print(f"[sauvegarde] échec : {e}", flush=True)
        time.sleep(3600)


if backups_enabled():
    threading.Thread(target=backup_loop, daemon=True).start()


# ---------- Application ----------

app = FastAPI(title="Inventaire d'atelier", docs_url=None, redoc_url=None)


def workshop_name(con) -> str:
    row = con.execute("SELECT value FROM settings WHERE key = 'name'").fetchone()
    return row["value"] if row else DEFAULT_NAME


def file_prefix() -> str:
    """Préfixe des fichiers téléchargés, tiré du nom de l'atelier (« Mon atelier » → « inventaire-mon-atelier »)."""
    with connect() as con:
        name = workshop_name(con)
    slug = unicodedata.normalize("NFD", name.lower())
    slug = "".join(c for c in slug if unicodedata.category(c) != "Mn")
    slug = re.sub(r"[^a-z0-9]+", "-", slug).strip("-")
    return f"inventaire-{slug}" if slug else "inventaire"


@app.get("/api/settings")
def get_settings():
    with connect() as con:
        return {"name": workshop_name(con), "version": VERSION}


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    with connect() as con:
        if body.name is not None:
            name = " ".join(body.name.split())
            if not name:
                raise HTTPException(400, "Le nom de l'atelier ne peut pas être vide.")
            con.execute("INSERT INTO settings (key, value) VALUES ('name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (name,))
        return {"name": workshop_name(con), "version": VERSION}


@app.get("/api/data")
def all_data():
    with connect() as con:
        locations = [dict(r) for r in con.execute("SELECT * FROM locations ORDER BY name COLLATE NOCASE")]
        tags = {}
        for r in con.execute("SELECT item_id, tag FROM item_tags ORDER BY tag"):
            tags.setdefault(r["item_id"], []).append(r["tag"])
        items = []
        for r in con.execute("SELECT * FROM items ORDER BY name COLLATE NOCASE"):
            d = dict(r)
            d["wanted"] = bool(d["wanted"])
            d["tags"] = tags.get(d["id"], [])
            items.append(d)
    return {"locations": locations, "items": items}


# --- Emplacements ---

@app.post("/api/locations")
def create_location(body: LocationIn):
    name = clean_name(body.name)
    with connect() as con:
        check_parent(con, None, body.parent_id)
        t = now()
        cur = con.execute(
            "INSERT INTO locations (parent_id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (body.parent_id, name, (body.note or "").strip(), t, t))
        return dict(location_row(con, cur.lastrowid))


@app.patch("/api/locations/{loc_id}")
def update_location(loc_id: int, body: LocationIn):
    fields = body.model_dump(exclude_unset=True)
    with connect() as con:
        location_row(con, loc_id)
        sets, values = [], []
        if "name" in fields:
            sets.append("name = ?"); values.append(clean_name(fields["name"]))
        if "parent_id" in fields:
            check_parent(con, loc_id, fields["parent_id"])
            sets.append("parent_id = ?"); values.append(fields["parent_id"])
        if "note" in fields:
            sets.append("note = ?"); values.append((fields["note"] or "").strip())
        if fields.get("verified"):
            sets.append("verified_at = ?"); values.append(now())
        if sets:
            sets.append("updated_at = ?"); values.append(now())
            con.execute(f"UPDATE locations SET {', '.join(sets)} WHERE id = ?", (*values, loc_id))
        return dict(location_row(con, loc_id))


@app.delete("/api/locations/{loc_id}")
def delete_location(loc_id: int):
    with connect() as con:
        row = location_row(con, loc_id)
        busy = con.execute(
            "SELECT (SELECT COUNT(*) FROM locations WHERE parent_id = ?) + (SELECT COUNT(*) FROM items WHERE location_id = ?)",
            (loc_id, loc_id)).fetchone()[0]
        if busy:
            raise HTTPException(409, "Ce contenant n'est pas vide. Déplacez ou supprimez d'abord ce qu'il contient.")
        con.execute("DELETE FROM locations WHERE id = ?", (loc_id,))
    delete_photo(row["photo"])
    return {"ok": True}


@app.post("/api/locations/{loc_id}/photo")
def set_location_photo(loc_id: int, file: UploadFile = File(...)):
    name = save_photo(file)
    with connect() as con:
        old = location_row(con, loc_id)["photo"]
        con.execute("UPDATE locations SET photo = ?, updated_at = ? WHERE id = ?", (name, now(), loc_id))
        result = dict(location_row(con, loc_id))
    delete_photo(old)
    return result


@app.delete("/api/locations/{loc_id}/photo")
def remove_location_photo(loc_id: int):
    with connect() as con:
        old = location_row(con, loc_id)["photo"]
        con.execute("UPDATE locations SET photo = NULL, updated_at = ? WHERE id = ?", (now(), loc_id))
        result = dict(location_row(con, loc_id))
    delete_photo(old)
    return result


# --- Articles ---

def write_tags(con, item_id: int, tags: list[str]) -> None:
    con.execute("DELETE FROM item_tags WHERE item_id = ?", (item_id,))
    con.executemany("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)", [(item_id, t) for t in clean_tags(tags)])


def insert_item(con, *, name, location_id, qty_mode="exact", qty=0, level=2, low_at=None, wanted=False,
                note="", buy_url="", price=None, tags=(), photo=None, origin=None) -> int:
    t = now()
    cur = con.execute(
        """INSERT INTO items (name, location_id, qty_mode, qty, level, low_at, wanted, note, buy_url, price, photo,
                              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (name, location_id, qty_mode, qty, level, low_at, int(bool(wanted)), note, buy_url, price, photo, t, t))
    item_id = cur.lastrowid
    write_tags(con, item_id, list(tags))
    amount = qty if qty_mode == "exact" else LEVELS[level]
    log(con, item_id, "created", origin, path_text(con, location_id), amount if qty_mode == "exact" else None)
    return item_id


@app.post("/api/items")
def create_item(body: ItemIn):
    name = clean_name(body.name)
    with connect() as con:
        if body.location_id is not None:
            location_row(con, body.location_id)
        item_id = insert_item(
            con, name=name, location_id=body.location_id, qty_mode=body.qty_mode or "exact", qty=body.qty or 0,
            level=2 if body.level is None else body.level, low_at=body.low_at, wanted=bool(body.wanted),
            note=(body.note or "").strip(), buy_url=clean_url(body.buy_url), price=body.price, tags=body.tags or [])
        return item_dict(con, item_row(con, item_id))


@app.patch("/api/items/{item_id}")
def update_item(item_id: int, body: ItemIn):
    fields = body.model_dump(exclude_unset=True)
    event = fields.pop("event", None)
    with connect() as con:
        old = item_row(con, item_id)
        sets, values = [], []

        def put(col, val):
            sets.append(f"{col} = ?"); values.append(val)

        if "name" in fields:
            put("name", clean_name(fields["name"]))
        if "location_id" in fields:
            if fields["location_id"] is not None:
                location_row(con, fields["location_id"])
            put("location_id", fields["location_id"])
        for key in ("qty_mode", "qty", "level"):
            if fields.get(key) is not None:
                put(key, fields[key])
        if "low_at" in fields:
            put("low_at", fields["low_at"])
        if "wanted" in fields:
            put("wanted", int(bool(fields["wanted"])))
        if "note" in fields:
            put("note", (fields["note"] or "").strip())
        if "buy_url" in fields:
            put("buy_url", clean_url(fields["buy_url"]))
        if "price" in fields:
            put("price", fields["price"])
        put("updated_at", now())
        con.execute(f"UPDATE items SET {', '.join(sets)} WHERE id = ?", (*values, item_id))
        if fields.get("tags") is not None:
            write_tags(con, item_id, fields["tags"])
        new = item_row(con, item_id)

        # Historique
        if new["location_id"] != old["location_id"]:
            log(con, item_id, "moved", path_text(con, old["location_id"]), path_text(con, new["location_id"]))
        if event == "buy":
            if new["qty_mode"] == "exact":
                log(con, item_id, "bought", old["qty"], new["qty"], new["qty"] - old["qty"])
            else:
                log(con, item_id, "bought", LEVELS[old["level"]], LEVELS[new["level"]])
        elif event == "missing":
            log(con, item_id, "missing")
        else:
            if new["qty_mode"] != old["qty_mode"]:
                log(con, item_id, "mode", None, new["qty_mode"])
            if new["qty_mode"] == "exact" and new["qty"] != old["qty"]:
                log(con, item_id, "qty", old["qty"], new["qty"])
            if new["qty_mode"] == "approx" and new["level"] != old["level"]:
                log(con, item_id, "level", LEVELS[old["level"]], LEVELS[new["level"]])
            if new["wanted"] != old["wanted"]:
                log(con, item_id, "wanted", None, new["wanted"])
        if new["name"] != old["name"]:
            log(con, item_id, "renamed", old["name"], new["name"])
        return item_dict(con, new)


@app.delete("/api/items/{item_id}")
def delete_item(item_id: int):
    with connect() as con:
        row = item_row(con, item_id)
        con.execute("DELETE FROM items WHERE id = ?", (item_id,))
    delete_photo(row["photo"])
    return {"ok": True}


@app.get("/api/items/{item_id}/history")
def item_history(item_id: int):
    with connect() as con:
        item_row(con, item_id)
        return [dict(r) for r in con.execute(
            "SELECT at, kind, old, new, n, ref FROM history WHERE item_id = ? ORDER BY id DESC LIMIT 60", (item_id,))]


@app.post("/api/items/{item_id}/photo")
def set_item_photo(item_id: int, file: UploadFile = File(...)):
    name = save_photo(file)
    with connect() as con:
        old = item_row(con, item_id)["photo"]
        con.execute("UPDATE items SET photo = ?, updated_at = ? WHERE id = ?", (name, now(), item_id))
        result = item_dict(con, item_row(con, item_id))
    delete_photo(old)
    return result


@app.delete("/api/items/{item_id}/photo")
def remove_item_photo(item_id: int):
    with connect() as con:
        old = item_row(con, item_id)["photo"]
        con.execute("UPDATE items SET photo = NULL, updated_at = ? WHERE id = ?", (now(), item_id))
        result = item_dict(con, item_row(con, item_id))
    delete_photo(old)
    return result


@app.post("/api/items/{item_id}/move")
def move_item(item_id: int, body: MoveIn):
    """Déplace tout ou partie du stock d'un article vers un autre emplacement."""
    with connect() as con:
        src = item_row(con, item_id)
        location_row(con, body.location_id)
        if src["location_id"] == body.location_id:
            raise HTTPException(400, "L'article est déjà rangé à cet endroit.")
        t = now()
        from_path, to_path = path_text(con, src["location_id"]), path_text(con, body.location_id)
        partial = src["qty_mode"] == "exact" and body.qty is not None and body.qty < src["qty"]
        if not partial:
            con.execute("UPDATE items SET location_id = ?, updated_at = ? WHERE id = ?", (body.location_id, t, item_id))
            log(con, item_id, "moved", from_path, to_path)
            return {"items": [item_dict(con, item_row(con, item_id))]}

        con.execute("UPDATE items SET qty = qty - ?, updated_at = ? WHERE id = ?", (body.qty, t, item_id))
        log(con, item_id, "split_out", from_path, to_path, body.qty)
        target = None
        for r in con.execute("SELECT * FROM items WHERE location_id = ? AND qty_mode = 'exact' AND id != ?",
                             (body.location_id, item_id)):
            if r["name"].casefold().strip() == src["name"].casefold().strip():
                target = r
                break
        if target is not None:
            con.execute("UPDATE items SET qty = qty + ?, updated_at = ? WHERE id = ?", (body.qty, t, target["id"]))
            log(con, target["id"], "split_in", from_path, to_path, body.qty)
            dest_id = target["id"]
        else:
            tags = [r["tag"] for r in con.execute("SELECT tag FROM item_tags WHERE item_id = ?", (item_id,))]
            dest_id = insert_item(
                con, name=src["name"], location_id=body.location_id, qty=body.qty, level=src["level"],
                low_at=src["low_at"], note=src["note"], buy_url=src["buy_url"], price=src["price"],
                tags=tags, photo=copy_photo(src["photo"]), origin=from_path)
        return {"items": [item_dict(con, item_row(con, item_id)), item_dict(con, item_row(con, dest_id))]}


@app.post("/api/tags/rename")
def rename_tag(body: TagRenameIn):
    """Renomme un tag sur tous les articles. Un nom déjà existant fusionne les deux ; un nom vide supprime le tag."""
    old, new = clean_tag(body.old), clean_tag(body.new)
    with connect() as con:
        ids = [r["item_id"] for r in con.execute("SELECT item_id FROM item_tags WHERE tag = ?", (old,))]
        if new and new != old:
            con.executemany("INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)", [(i, new) for i in ids])
        if new != old:
            con.execute("DELETE FROM item_tags WHERE tag = ?", (old,))
    return {"ok": True, "count": len(ids)}


# --- Projets ---

def project_row(con, pid: int) -> sqlite3.Row:
    row = con.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    if row is None:
        raise HTTPException(404, "Ce projet n'existe plus.")
    return row


def project_dict(con, pid: int) -> dict:
    d = dict(project_row(con, pid))
    d["lines"] = [dict(r) for r in con.execute(
        "SELECT id, item_id, name, qty FROM project_lines WHERE project_id = ? ORDER BY position, id", (pid,))]
    d["takes"] = [dict(r) for r in con.execute(
        "SELECT item_id, name, path, qty, level_from, level_to FROM project_takes WHERE project_id = ? ORDER BY id", (pid,))]
    return d


def require_draft(row) -> None:
    if row["status"] != "draft":
        raise HTTPException(400, "Ce projet a déjà été sorti. Utilisez « Refaire ce projet » pour en préparer un nouveau.")


@app.get("/api/projects")
def list_projects():
    with connect() as con:
        return [dict(r) for r in con.execute(
            """SELECT p.*, (SELECT COUNT(*) FROM project_lines l WHERE l.project_id = p.id) AS line_count
               FROM projects p ORDER BY p.status = 'done', COALESCE(p.done_at, p.updated_at) DESC""")]


@app.post("/api/projects")
def create_project(body: ProjectIn):
    name = clean_name(body.name)
    with connect() as con:
        t = now()
        cur = con.execute("INSERT INTO projects (name, note, created_at, updated_at) VALUES (?, ?, ?, ?)",
                          (name, (body.note or "").strip(), t, t))
        return project_dict(con, cur.lastrowid)


@app.get("/api/projects/{pid}")
def get_project(pid: int):
    with connect() as con:
        return project_dict(con, pid)


@app.patch("/api/projects/{pid}")
def update_project(pid: int, body: ProjectIn):
    fields = body.model_dump(exclude_unset=True)
    with connect() as con:
        project_row(con, pid)
        if "name" in fields:
            con.execute("UPDATE projects SET name = ? WHERE id = ?", (clean_name(fields["name"]), pid))
        if "note" in fields:
            con.execute("UPDATE projects SET note = ? WHERE id = ?", ((fields["note"] or "").strip(), pid))
        con.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now(), pid))
        return project_dict(con, pid)


@app.delete("/api/projects/{pid}")
def delete_project(pid: int):
    with connect() as con:
        project_row(con, pid)
        con.execute("DELETE FROM projects WHERE id = ?", (pid,))
    return {"ok": True}


@app.post("/api/projects/{pid}/lines")
def add_line(pid: int, body: LineIn):
    with connect() as con:
        require_draft(project_row(con, pid))
        if body.item_id is None:
            raise HTTPException(400, "Choisissez un article.")
        it = item_row(con, body.item_id)
        qty = 1 if body.qty is None else body.qty
        existing = con.execute("SELECT id FROM project_lines WHERE project_id = ? AND item_id = ?", (pid, it["id"])).fetchone()
        if existing:
            con.execute("UPDATE project_lines SET qty = qty + ? WHERE id = ?", (qty, existing["id"]))
        else:
            pos = con.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM project_lines WHERE project_id = ?", (pid,)).fetchone()[0]
            con.execute("INSERT INTO project_lines (project_id, item_id, name, qty, position) VALUES (?, ?, ?, ?, ?)",
                        (pid, it["id"], it["name"], qty, pos))
        con.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now(), pid))
        return project_dict(con, pid)


@app.patch("/api/projects/{pid}/lines/{line_id}")
def update_line(pid: int, line_id: int, body: LineIn):
    with connect() as con:
        require_draft(project_row(con, pid))
        if body.qty is not None:
            con.execute("UPDATE project_lines SET qty = ? WHERE id = ? AND project_id = ?", (body.qty, line_id, pid))
        con.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now(), pid))
        return project_dict(con, pid)


@app.delete("/api/projects/{pid}/lines/{line_id}")
def delete_line(pid: int, line_id: int):
    with connect() as con:
        require_draft(project_row(con, pid))
        con.execute("DELETE FROM project_lines WHERE id = ? AND project_id = ?", (line_id, pid))
        con.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now(), pid))
        return project_dict(con, pid)


@app.post("/api/projects/{pid}/checkout")
def checkout_project(pid: int, body: CheckoutIn):
    """Décompte du stock pour tout ce qui sort, en une seule transaction."""
    with connect() as con:
        proj = project_row(con, pid)
        require_draft(proj)
        # Contrôle préalable : rien n'est modifié si une ligne pose problème
        totals = {}
        for t in body.takes:
            totals[t.item_id] = totals.get(t.item_id, 0) + (t.qty or 0)
        for item_id, n in totals.items():
            it = item_row(con, item_id)
            if it["qty_mode"] == "exact" and n > it["qty"]:
                raise HTTPException(400, f"Stock insuffisant pour « {it['name']} » : {n} à sortir, {it['qty']} en stock. Corrigez la quantité.")
        changed = set()
        for t in body.takes:
            it = item_row(con, t.item_id)
            path = path_text(con, it["location_id"])
            if it["qty_mode"] == "exact":
                if not t.qty:
                    continue
                new_qty = it["qty"] - t.qty
                con.execute("UPDATE items SET qty = ?, updated_at = ? WHERE id = ?", (new_qty, now(), it["id"]))
                log(con, it["id"], "taken", it["qty"], new_qty, t.qty, ref=proj["name"])
                con.execute("INSERT INTO project_takes (project_id, item_id, name, path, qty) VALUES (?, ?, ?, ?, ?)",
                            (pid, it["id"], it["name"], path, t.qty))
            else:
                level = it["level"] if t.level is None else t.level
                con.execute("UPDATE items SET level = ?, updated_at = ? WHERE id = ?", (level, now(), it["id"]))
                log(con, it["id"], "taken", LEVELS[it["level"]], LEVELS[level], ref=proj["name"])
                con.execute("INSERT INTO project_takes (project_id, item_id, name, path, level_from, level_to) VALUES (?, ?, ?, ?, ?, ?)",
                            (pid, it["id"], it["name"], path, LEVELS[it["level"]], LEVELS[level]))
            changed.add(it["id"])
        t = now()
        con.execute("UPDATE projects SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?", (t, t, pid))
        return {"project": project_dict(con, pid), "items": [item_dict(con, item_row(con, i)) for i in changed]}


@app.post("/api/projects/{pid}/duplicate")
def duplicate_project(pid: int):
    with connect() as con:
        src = project_dict(con, pid)
        t = now()
        cur = con.execute("INSERT INTO projects (name, note, created_at, updated_at) VALUES (?, ?, ?, ?)",
                          (src["name"], src["note"], t, t))
        new_id = cur.lastrowid
        lines = src["lines"] if src["status"] == "draft" else []
        if src["status"] == "done":
            merged = {}
            for tk in src["takes"]:
                if tk["item_id"] is None:
                    continue
                key = tk["item_id"]
                merged[key] = (tk["name"], merged.get(key, (None, 0))[1] + (tk["qty"] or 1))
            lines = [{"item_id": k, "name": v[0], "qty": v[1]} for k, v in merged.items()]
        for i, ln in enumerate(lines):
            con.execute("INSERT INTO project_lines (project_id, item_id, name, qty, position) VALUES (?, ?, ?, ?, ?)",
                        (new_id, ln["item_id"], ln["name"], ln["qty"], i + 1))
        return project_dict(con, new_id)


# --- Sauvegardes ---

@app.get("/api/backups")
def backups_status():
    files = list_backups()
    last = None
    if files:
        last = datetime.fromtimestamp(os.path.getmtime(os.path.join(BACKUP_DIR, files[-1])), timezone.utc).isoformat(timespec="seconds")
    return {"enabled": backups_enabled(), "count": len(files), "last": last, "keep": BACKUP_KEEP}


@app.get("/api/backup")
def download_backup():
    fd, path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    write_backup(path)
    name = f"{file_prefix()}-{datetime.now().strftime('%Y-%m-%d')}.zip"
    return FileResponse(path, media_type="application/zip", filename=name, background=BackgroundTask(os.remove, path))


# --- Export et import CSV ---

CSV_COLUMNS = ["nom", "emplacement", "mode", "quantite", "niveau", "seuil", "tags", "a_acheter", "lien", "prix", "note"]


def csv_response(rows: list[list], filename: str) -> Response:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(CSV_COLUMNS)
    w.writerows(rows)
    return Response("\ufeff" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/export.csv")
def export_csv():
    rows = []
    with connect() as con:
        for it in con.execute("SELECT * FROM items ORDER BY name COLLATE NOCASE"):
            d = item_dict(con, it)
            approx = d["qty_mode"] == "approx"
            rows.append([
                d["name"], path_text(con, d["location_id"]), "approximatif" if approx else "exact",
                "" if approx else d["qty"], LEVELS[d["level"]] if approx else "",
                "" if d["low_at"] is None else (LEVELS[d["low_at"]] if approx else d["low_at"]),
                "; ".join(d["tags"]), "oui" if d["wanted"] else "non", d["buy_url"],
                "" if d["price"] is None else str(d["price"]).replace(".", ","), d["note"],
            ])
    return csv_response(rows, f"{file_prefix()}-{datetime.now().strftime('%Y-%m-%d')}.csv")


@app.get("/api/import-template.csv")
def import_template():
    return csv_response([
        ["Résistance 10 kΩ 0805", "Bureau › Meuble A › Carton X", "approximatif", "", "Beaucoup", "Peu", "résistance; cms", "non", "", "", ""],
        ["Arduino Mega", "Bureau › Meuble A › Carton X", "exact", "2", "", "1", "microcontrôleur; arduino", "non", "https://exemple.com/arduino-mega", "35,90", ""],
    ], "modele-import.csv")


def norm_key(s: str) -> str:
    s = unicodedata.normalize("NFD", s.strip().lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn").replace(" ", "_").replace("é", "e")


def find_or_create_path(con, path: str, cache: dict, created: list) -> Optional[int]:
    parts = [p.strip() for p in path.replace("›", ">").split(">") if p.strip()]
    parent = None
    for name in parts:
        key = (parent, name.casefold())
        if key not in cache:
            row = None
            for r in con.execute("SELECT id, name FROM locations WHERE parent_id IS ?", (parent,)):
                if r["name"].casefold() == name.casefold():
                    row = r
                    break
            if row is None:
                t = now()
                cur = con.execute("INSERT INTO locations (parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                                  (parent, name, t, t))
                cache[key] = cur.lastrowid
                created.append(name)
            else:
                cache[key] = row["id"]
        parent = cache[key]
    return parent


def parse_level(v: str) -> Optional[int]:
    v = norm_key(v)
    for i, label in enumerate(LEVELS):
        if v == norm_key(label):
            return i
    return int(v) if v.isdigit() and int(v) <= 3 else None


@app.post("/api/import")
def import_csv(file: UploadFile = File(...)):
    raw = file.file.read()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    first = text.split("\n", 1)[0]
    delim = ";" if first.count(";") >= first.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    try:
        header = [norm_key(h) for h in next(reader)]
    except StopIteration:
        raise HTTPException(400, "Le fichier est vide.")
    if "nom" not in header:
        raise HTTPException(400, "Colonne « nom » introuvable. Partez du modèle proposé pour être sûr du format.")
    idx = {k: header.index(k) for k in CSV_COLUMNS if k in header}

    created, skipped, errors, new_locs, cache = 0, 0, [], [], {}
    with connect() as con:
        for line_no, row in enumerate(reader, start=2):
            get = lambda k: row[idx[k]].strip() if k in idx and idx[k] < len(row) else ""
            name = get("nom")
            if not name:
                if any(c.strip() for c in row):
                    errors.append(f"Ligne {line_no} : nom manquant.")
                continue
            try:
                loc = find_or_create_path(con, get("emplacement"), cache, new_locs) if get("emplacement") else None
                level = parse_level(get("niveau")) if get("niveau") else None
                mode = "approx" if norm_key(get("mode")).startswith("approx") or (level is not None and not get("quantite")) else "exact"
                qty = int(float(get("quantite").replace(",", "."))) if get("quantite") else 0
                low_raw = get("seuil")
                low = (parse_level(low_raw) if mode == "approx" else int(float(low_raw.replace(",", ".")))) if low_raw else None
                price = float(get("prix").replace(",", ".").replace("€", "").strip()) if get("prix") else None
            except ValueError:
                errors.append(f"Ligne {line_no} : une valeur numérique est illisible (quantité, seuil ou prix).")
                continue
            dup = con.execute("SELECT name FROM items WHERE location_id IS ?", (loc,)).fetchall()
            if any(r["name"].casefold() == name.casefold() for r in dup):
                skipped += 1
                continue
            insert_item(con, name=name[:200], location_id=loc, qty_mode=mode, qty=max(0, qty),
                        level=2 if level is None else level, low_at=low,
                        wanted=norm_key(get("a_acheter")) in ("oui", "o", "1", "x", "yes", "vrai"),
                        note=get("note"), buy_url=clean_url(get("lien")), price=price,
                        tags=[t for t in get("tags").replace(",", ";").split(";")], origin="import")
            created += 1
    return {"created": created, "skipped": skipped, "locations": len(new_locs), "errors": errors[:20]}


app.mount("/photos", StaticFiles(directory=PHOTO_DIR), name="photos")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
