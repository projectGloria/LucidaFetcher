const yt = require('./youtube-dl.js');
async function run() {
  try {
    const meta = await yt.fetchMetadata('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    console.log(meta);
  } catch (e) {
    console.error('ERROR:', e);
  }
}
run();
