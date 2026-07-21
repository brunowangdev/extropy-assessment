export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, details);
export const unauthorized = (msg = 'Unauthorized') => new AppError(401, msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, msg);
export const notFound = (msg = 'Not found') => new AppError(404, msg);
export const conflict = (msg: string) => new AppError(409, msg);
export const serviceUnavailable = (msg: string) => new AppError(503, msg);

export const toErrorResponse = (err: unknown): { status: number; body: string } => {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: JSON.stringify({ error: err.message, details: err.details }),
    };
  }
  console.error('Unhandled error:', err);
  return { status: 500, body: JSON.stringify({ error: 'Internal server error' }) };
};
