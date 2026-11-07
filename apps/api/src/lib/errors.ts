export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errors = {
  notFound: (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`),
  slotTaken: () => new ApiError(409, 'SLOT_TAKEN', 'That time is no longer available'),
  slotFull: () => new ApiError(409, 'SLOT_FULL', 'This session is full'),
  slotInvalid: (why: string) => new ApiError(422, 'SLOT_INVALID', why),
  holdExpired: () => new ApiError(410, 'HOLD_EXPIRED', 'Your hold expired; please pick the slot again'),
  bookingNotActive: () => new ApiError(409, 'BOOKING_NOT_ACTIVE', 'This booking is cancelled'),
  idempotencyMismatch: () =>
    new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request'),
  badRequest: (msg: string) => new ApiError(400, 'BAD_REQUEST', msg),
  unauthorized: () => new ApiError(401, 'UNAUTHORIZED', 'Login required'),
};
