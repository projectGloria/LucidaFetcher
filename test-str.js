const s = `
  let image = "";
  if (image) image = image.replace(/(\\?|&)w=\\d+/g, '').replace(/(\\?|&)h=\\d+/g, '');
`;
console.log(s);
