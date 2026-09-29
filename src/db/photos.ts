import { nowIso } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { assertTripOpen, loadExpense, loadTrip, openForRead, openForWrite, requireMemberActor, writeActivity } from './internal.js';
import type { Db, ExpensePhoto, Scope } from './types.js';

const COLUMNS = `id, group_id AS groupId, expense_id AS expenseId, file_key AS fileKey,
  width, height, bytes, added_by_member_id AS addedByMemberId, created_at AS createdAt`;

export function listExpensePhotos(db: Db, scope: Scope, expenseId: number): ExpensePhoto[] {
  openForRead(db, scope);
  loadExpense(db, scope, expenseId);
  return db.prepare(`SELECT ${COLUMNS} FROM expense_photo WHERE group_id = ? AND expense_id = ? ORDER BY id`).all(scope.groupId, expenseId) as ExpensePhoto[];
}

export function getExpensePhoto(db: Db, scope: Scope, id: number): ExpensePhoto {
  openForRead(db, scope);
  const photo = db.prepare(`SELECT ${COLUMNS} FROM expense_photo WHERE group_id = ? AND id = ?`).get(scope.groupId, id) as ExpensePhoto | undefined;
  if (!photo) throw new NotFoundError('photo', id);
  return photo;
}

export function assertExpensePhotosWritable(db: Db, scope: Scope, expenseId: number): void {
  openForWrite(db, scope);
  requireMemberActor(scope);
  const expense = loadExpense(db, scope, expenseId);
  assertTripOpen(loadTrip(db, scope, expense.tripId));
  if (expense.status !== 'draft' && expense.status !== 'confirmed') {
    throw new ValidationError('invalid_status', 'This expense was removed. Restore it first to change its photos.');
  }
}

export function addExpensePhoto(db: Db, scope: Scope, expenseId: number, input: Pick<ExpensePhoto, 'fileKey' | 'width' | 'height' | 'bytes'>): ExpensePhoto {
  return db.transaction(() => {
    assertExpensePhotosWritable(db, scope, expenseId);
    if (listExpensePhotos(db, scope, expenseId).length >= 3) throw new ValidationError('photo_limit', 'An expense can have at most 3 photos. Remove a photo before adding another.');
    const id = Number(db.prepare(`INSERT INTO expense_photo (group_id, expense_id, file_key, width, height, bytes, added_by_member_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      scope.groupId, expenseId, input.fileKey, input.width, input.height, input.bytes, requireMemberActor(scope), nowIso(),
    ).lastInsertRowid);
    const photo = getExpensePhoto(db, scope, id);
    writeActivity(db, scope, { tripId: loadExpense(db, scope, expenseId).tripId, action: 'expense.photo_added', entityType: 'expense', entityId: expenseId, before: null, after: { photoId: id, width: photo.width, height: photo.height } });
    return photo;
  })();
}

/** The caller removes the file in the same synchronous transaction; failure rolls back the row and history. */
export function removeExpensePhoto(db: Db, scope: Scope, id: number): ExpensePhoto {
  return db.transaction(() => {
    const photo = getExpensePhoto(db, scope, id);
    assertExpensePhotosWritable(db, scope, photo.expenseId);
    db.prepare('DELETE FROM expense_photo WHERE group_id = ? AND id = ?').run(scope.groupId, id);
    writeActivity(db, scope, { tripId: loadExpense(db, scope, photo.expenseId).tripId, action: 'expense.photo_removed', entityType: 'expense', entityId: photo.expenseId, before: { photoId: id, width: photo.width, height: photo.height }, after: null });
    return photo;
  })();
}
