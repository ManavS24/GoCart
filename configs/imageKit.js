import ImageKit from "imagekit";

// Constructed per call, not at module load. The SDK throws when its keys are
// unset, which would fail `next build` while collecting page data.
const getImageKit = () => new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

export default getImageKit;
