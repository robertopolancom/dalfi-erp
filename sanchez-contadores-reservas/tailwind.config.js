/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        marca: {
          50:  '#eef4ff',
          100: '#d9e6ff',
          500: '#3563d6',
          600: '#2b50b4',
          700: '#233f8e',
        },
      },
    },
  },
  plugins: [],
}
