import { LocalFile } from '../types';

export interface LocalStore {
  list(): Promise<LocalFile[]>; // all files and folders, recursive, including configDir
  stat(path: string): Promise<LocalFile | null>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalFile>; // creates parent folders
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdirIfEmpty(path: string): Promise<boolean>;
}
