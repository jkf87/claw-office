declare module "*.css";
declare module "*.glb?url" { const url: string; export default url; }
declare module "virtual:remote-script" { const script: string; export default script; }
