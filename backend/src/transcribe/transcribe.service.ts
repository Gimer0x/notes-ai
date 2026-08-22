export type MeetingLanguage = 'en' | 'es';

export type TranscriptResult = {
  language: MeetingLanguage;
  transcript: string;
};

export interface TranscribeService {
  transcribe(wavPaths: string[]): Promise<TranscriptResult>;
  transcribeBuffers(
    buffers: Buffer[],
    originalName: string,
  ): Promise<TranscriptResult>;
}
