export class ApiError extends Error {
  constructor(public code: number, message: string) { super(message); }
}
export function videoId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value)) throw new ApiError(400, 'videoId không hợp lệ.');
  return value;
}
