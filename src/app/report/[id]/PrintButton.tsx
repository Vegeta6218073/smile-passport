'use client';

export default function PrintButton() {
  return <button type="button" onClick={() => window.print()} className="no-print">Print or save as PDF</button>;
}
