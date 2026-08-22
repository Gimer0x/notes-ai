export type MeetingLanguage = 'en' | 'es';

export type TranscriptResult = {
  language: MeetingLanguage;
  transcript: string;
};

export interface TranscribeService {
  transcribe(wavPathsOrBuffers: Buffer[], originalName: string): Promise<TranscriptResult>;
}
