export interface ServicePrincipal {
  kind: 'service';
}

export interface RequestWithService {
  service?: ServicePrincipal;
}
