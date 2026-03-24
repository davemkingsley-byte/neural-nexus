const path = require('path');
const fs = require('fs');
const { generateSEOReport } = require('../src/seo-engine');

(async () => {
  console.log('Generating SEO report...\n');
  try {
    const report = await generateSEOReport();

    console.log('=== SEO Health Report ===');
    console.log('Week: ' + report.weekOf);
    console.log('Generated: ' + report.generatedAt);
    console.log('Overall Score: ' + report.overallScore + '/100');
    console.log('Total Pages: ' + report.totalPages);
    console.log('Pages with Issues: ' + report.pagesWithIssues);
    console.log('\nStatus Counts:', JSON.stringify(report.statusCounts));
    console.log('\nTop Issues:');
    for (const { issue, count } of report.topIssues) {
      console.log('  - ' + issue + ' (' + count + ')');
    }
    console.log('\nPer-page scores:');
    for (const p of report.pages) {
      console.log('  ' + p.score + '/100  ' + p.url + (p.issues.length ? '  [' + p.issues.join(', ') + ']' : ''));
    }

    if (process.argv.includes('--save')) {
      const dataDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const filePath = path.join(dataDir, 'seo-reports.json');
      let reports = [];
      try { if (fs.existsSync(filePath)) reports = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
      reports = reports.filter(r => r.weekOf !== report.weekOf);
      reports.unshift(report);
      if (reports.length > 52) reports = reports.slice(0, 52);
      fs.writeFileSync(filePath, JSON.stringify(reports, null, 2));
      console.log('\nReport saved to data/seo-reports.json');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
