// # Backblaze Setup

// Bucket:
// veoLMS

// Region:
// eu-central-003

// Endpoint:
// https://s3.eu-central-003.backblazeb2.com

// Update CORS:

// aws s3api put-bucket-cors \
//   --profile veoLMS \
//   --bucket veoLMS \
//   --cors-configuration file://cors.json \
//   --endpoint-url https://s3.eu-central-003.backblazeb2.com

// Verify:

// aws s3api get-bucket-cors \
//   --profile veoLMS \
//   --bucket veoLMS \
//   --endpoint-url https://s3.eu-central-003.backblazeb2.com


//THE FILE ** cors.js **
// {
//   "CORSRules": [
//     {
//       "AllowedOrigins": [
//         "http://localhost:5173"
//       ],
//       "AllowedMethods": [
//         "GET",
//         "PUT",
//         "POST",
//         "HEAD"
//       ],
//       "AllowedHeaders": ["*"],
//       "ExposeHeaders": [
//         "ETag",
//         "x-amz-request-id",
//         "x-amz-id-2"
//       ],
//       "MaxAgeSeconds": 3600
//     }
//   ]
// }