export type JpegErrorCode = 'not-jpeg' | 'cmyk' | 'unsupported' | 'corrupt';

/** A JPEG this app refuses or cannot read. The message is shown to the user after the file name. */
export class JpegError extends Error {
  readonly code: JpegErrorCode;
  constructor(code: JpegErrorCode, message: string) {
    super(message);
    this.name = 'JpegError';
    this.code = code;
  }
}
