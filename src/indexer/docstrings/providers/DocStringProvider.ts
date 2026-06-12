export interface DocstringProvider {
  generate(prompt: string): Promise<string | null>
}
