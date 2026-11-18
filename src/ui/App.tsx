export interface AppProps {
  readonly buildId: string;
}

export function App({ buildId }: AppProps) {
  return (
    <main>
      <h2>SP Telos</h2>
      <p>Build {buildId}</p>
    </main>
  );
}
