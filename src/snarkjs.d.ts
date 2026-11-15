declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(
      verificationKey: Record<string, unknown>,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
    exportVerificationKey(zkeyPath: string): Promise<Record<string, unknown>>;
  };
  export const zKey: {
    exportVerificationKey(zkeyPath: string): Promise<Record<string, unknown>>;
  };
}
