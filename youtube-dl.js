const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Helper module to use yt-dlp via youtube-dl-exec.
 */
async function downloadYoutubeLink(url, savePath, onProgress) {
  return new Promise((resolve, reject) => {
    try {
      const youtubedl = require('youtube-dl-exec');
      // Download best audio, extract audio, convert to mp3 or keep best
      const proc = youtubedl.exec(url, {
        extractAudio: true,
        audioFormat: 'best', // yt-dlp uses ffmpeg for this if available
        output: savePath,
        noCheckCertificates: true,
        noWarnings: true,
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0']
      });

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        // Parse progress if needed: [download]  10.0% of 5.00MiB at 1.00MiB/s
        const match = text.match(/\[download\]\s+([\d\.]+)%/);
        if (match && onProgress) {
          onProgress(parseFloat(match[1]));
        }
      });

      proc.stderr.on('data', (data) => {
        console.warn('[yt-dlp stderr]', data.toString());
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, savePath });
        } else {
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Fetch metadata (title, artist, thumbnail) using yt-dlp's dump-json.
 */
async function fetchMetadata(url) {
  return new Promise((resolve, reject) => {
    try {
      const youtubedl = require('youtube-dl-exec');
      youtubedl(url, {
        dumpJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0']
      }).then(output => {
        resolve({
          title: output.title || '',
          artist: output.uploader || output.artist || output.creator || '',
          thumbnail: output.thumbnail || ''
        });
      }).catch(err => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  downloadYoutubeLink,
  fetchMetadata
};
