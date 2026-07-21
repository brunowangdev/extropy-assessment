const raw = import.meta.env;

const required = (key: string): string => {
  const v = raw[key];
  if (!v) throw new Error(`Missing env var ${key}. Copy .env.example to .env and fill it in.`);
  return v;
};

export const config = {
  apiUrl: required('VITE_API_URL').replace(/\/$/, ''),
  chatUrl: required('VITE_CHAT_URL'),
};
