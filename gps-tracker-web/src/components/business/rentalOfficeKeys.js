import {authScope} from '../../authSession';

export const officeCatalogKey = (summary=false) => [authScope(),'rentalOffice','catalog',...(summary?['summary']:[])];
export const officeBookKey = period => [authScope(),'rentalOffice','book',...(period?[period]:[])];
